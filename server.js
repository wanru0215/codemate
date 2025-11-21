// 1. 引入需要的模組
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require("path");
const fetch = require("node-fetch");
const http = require('http');
const { Server } = require("socket.io");

// 2. 初始化 Express 應用
const app = express();
const PORT = process.env.PORT || 3000;

// 3. 設定中間件 (Middleware)
app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));

// --- 資料庫連線 ---
const mongoURI = process.env.MONGO_URI || 'mongodb+srv://user:WXXrWGcC9Z0LiYT3@cluster0.t2r6dop.mongodb.net/SCU?retryWrites=true&w=majority';

mongoose.connect(mongoURI)
  .then(() => console.log('成功連接到 MongoDB (SCU 資料庫)'))
  .catch(err => console.error('無法連接到 MongoDB:', err));

// --- Mongoose Schema & Model ---

// 學生帳號 Schema (保持不變)
const studentSchema = new mongoose.Schema({
  studentId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  password: { type: String, required: true },
  registrationTime: { type: Date, default: Date.now },
  lastLoginTime: { type: Date }
});
const Student = mongoose.model('Student', studentSchema, 'Students');

// 對話紀錄 Schema (保持不變)
const messageSchema = new mongoose.Schema({
  id: { type: Number, required: true },
  sender: { type: String, required: true },
  content: { type: String, required: true },
  timestamp: { type: Date, required: true }
}, { _id: false });
const learningRecordSchema = new mongoose.Schema({
  studentId: { type: String, required: true, index: true },
  conversation: [messageSchema],
  lastUpdated: { type: Date, default: Date.now }
});
const LearningRecord = mongoose.model('LearningRecord', learningRecordSchema, 'LearningRecords');

// 扁平化的測驗紀錄 Schema (保持不變)
const quizAttemptSchema = new mongoose.Schema({
  studentId: { type: String, required: true, index: true },
  quizId: { type: String, required: true, index: true },
  questionId: { type: String, required: true },
  answer: { type: String, required: true },
  isCorrect: { type: Boolean, required: true },
  timestamp: { type: Date, default: Date.now }
});
const QuizAttempt = mongoose.model('QuizAttempt', quizAttemptSchema, 'QuizAttempts');

// 後端輔助函數 (保持不變)
const reconstructProgress = (allAttempts) => {
  const quizzes = {}; 
  for (const attempt of allAttempts) {
    const { quizId, questionId, isCorrect, timestamp, answer } = attempt;
    if (!quizzes[quizId]) {
      quizzes[quizId] = {
        quizId: quizId,
        lastAttempted: new Date(0), 
        questions: {} 
      };
    }
    if (!quizzes[quizId].questions[questionId]) {
      quizzes[quizId].questions[questionId] = {
        questionId: questionId,
        correctCount: 0,
        incorrectCount: 0,
        attempts: []
      };
    }
    const quizProgress = quizzes[quizId];
    const questionProgress = quizzes[quizId].questions[questionId];
    questionProgress.attempts.push({ answer, isCorrect, timestamp });
    if (isCorrect) {
      questionProgress.correctCount += 1;
    } else {
      questionProgress.incorrectCount += 1;
    }
    if (timestamp > quizProgress.lastAttempted) {
      quizProgress.lastAttempted = timestamp;
    }
  }
  return quizzes; 
};
// --- API 路由 (Routes) ---

// 註冊 API: /api/register (保持不變)
app.post('/api/register', async (req, res) => {
  try {
    const { studentId, name, password } = req.body;
    if (!studentId || !name || !password) {
      return res.status(400).json({ message: '所有欄位均為必填' });
    }
    const existingStudent = await Student.findOne({ studentId });
    if (existingStudent) {
      return res.status(409).json({ message: '此學號已被註冊' });
    }
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    const newStudent = new Student({ studentId, name, password: hashedPassword });
    await newStudent.save();
    res.status(201).json({ message: '註冊成功' });
  } catch (error) {
    console.error('註冊錯誤:', error);
    res.status(500).json({ message: '伺服器內部錯誤' });
  }
});

// 登入 API: /api/login (保持不變)
app.post('/api/login', async (req, res) => {
  try {
    const { studentId, password } = req.body;
    if (!studentId || !password) {
      return res.status(400).json({ message: '學號和密碼為必填' });
    }
    const student = await Student.findOne({ studentId });
    if (!student) {
      return res.status(401).json({ message: '學號或密碼錯誤' });
    }
    const isMatch = await bcrypt.compare(password, student.password);
    if (!isMatch) {
      return res.status(401).json({ message: '學號或密碼錯誤' });
    }
    student.lastLoginTime = new Date();
    await student.save();
    res.status(200).json({ message: '登入成功', name: student.name });
  } catch (error) {
    console.error('登入錯誤:', error);
    res.status(500).json({ message: '伺服器內部錯誤' });
  }
});

// Gemini API 代理 (保持不變)
app.post("/api/chat", async (req, res) => {
  console.log("1. [API Chat] 收到前端個人化請求...");

  try {
    const { contents, systemInstruction, studentId } = req.body;

    if (!studentId || !contents) {
        return res.status(400).json({ error: { message: "請求中缺少 studentId 或 contents" } });
    }

    // --- 步驟 1: 從 MongoDB 讀取歷史對話作為風格範例 ---
    const record = await LearningRecord.findOne({ studentId });
    const fullHistory = record?.conversation || [];
    const fewShotExamples = [];
    if (fullHistory.length > 1) {
        console.log(`2. [API Chat] 找到學生 ${studentId} 的歷史紀錄，正在準備風格範例...`);
        let pairsFound = 0;
        for (let i = fullHistory.length - 1; i > 0 && pairsFound < 2; i--) {
            if (fullHistory[i].sender === 'user' && fullHistory[i-1].sender === 'ai') {
                fewShotExamples.unshift({ role: 'model', parts: [{ text: fullHistory[i-1].content }] });
                fewShotExamples.unshift({ role: 'user', parts: [{ text: fullHistory[i].content }] });
                pairsFound++;
            }
        }
    }

    // --- 步驟 2: 組合最終的提示 (Prompt) ---
    const finalContents = [
        ...fewShotExamples,
        ...contents
    ];
    
    const finalPayload = {
        contents: finalContents,
        systemInstruction: systemInstruction
    };

    // --- 步驟 3: 呼叫 Gemini API ---
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: { message: "伺服器缺少 GEMINI_API_KEY" } });
    }
    const modelName = "gemini-2.0-flash"; // (修正)
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

    console.log(`3. [API Chat] 正在將包含 ${finalContents.length} 則訊息的組合提示發送至 Gemini...`);

    const geminiResponse = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(finalPayload),
    });
    
    const data = await geminiResponse.json();

    if (!geminiResponse.ok) {
        console.error("4. [API Chat] Gemini API 錯誤:", JSON.stringify(data, null, 2));
        return res.status(geminiResponse.status).json(data);
    }
    
    console.log("5. [API Chat] 收到 Gemini 回應，準備回傳前端。");
    res.json(data);

  } catch (err) {
    console.error("6. [API Chat] 代理請求過程中發生嚴重錯誤:", err);
    res.status(500).json({ error: { message: "伺服器內部錯誤，無法呼叫 Gemini API" } });
  }
});

// 儲存對話紀錄 API (保持不變)
app.post('/api/log/conversation', async (req, res) => {
  try {
    const { studentId, conversation } = req.body;
    if (!studentId) {
      return res.status(400).json({ message: "儲存失敗：請求中缺少學生 ID" });
    }
    if (!conversation || !Array.isArray(conversation)) {
      return res.status(400).json({ message: "儲存失敗：對話內容格式不正確" });
    }
    await LearningRecord.findOneAndUpdate(
      { studentId: studentId },
      { $set: { conversation, lastUpdated: new Date() } },
      { upsert: true, new: true }
    );
    res.status(200).json({ message: "對話紀錄已成功儲存" });
  } catch (error) {
    console.error("儲存對話紀錄時發生錯誤:", error);
    res.status(500).json({ message: "伺服器內部錯誤" });
  }
});

// --- 🔽 [FIX] 這是您遺失的 API 路由！ ---
// 取得對話紀錄 API
app.get('/api/log/conversation/:studentId', async (req, res) => {
  try {
    const { studentId } = req.params;
    if (!studentId) {
      return res.status(400).json({ message: '缺少學生 ID' });
    }
    const record = await LearningRecord.findOne(
        { studentId },
        { conversation: { $slice: -50 } } // 只取最後 50 筆
    );

    if (record && record.conversation) {
      res.status(200).json(record.conversation);
    } else {
      res.status(200).json([]); // 如果沒有紀錄，回傳空陣列
    }
  } catch (error) {
    console.error("讀取對話紀錄時發生錯誤:", error);
    res.status(500).json({ message: '伺服器內部錯誤' });
  }
});
// --- 🔼 [FIX] ---------------------------


// [POST API] 提交「單一」測驗答案 (保持 v4 偵錯版本)
app.post('/api/progress/quiz/attempt', async (req, res) => {
  try {
    const { studentId, quizId, questionId, answer, isCorrect } = req.body;
    
    // --- [FIX] 更嚴格的檢查，防止 null 或 undefined ---
    if (
      !studentId || 
      !quizId || 
      !questionId || 
      answer === null || answer === undefined || // <-- 檢查 null 和 undefined
      isCorrect === null || isCorrect === undefined // <-- 檢查 null 和 undefined
    ) {
      console.error('[CodeMate 儲存失敗] 偵測到無效請求: 欄位為 null 或 undefined', req.body);
      return res.status(400).json({ message: "缺少必要的提交欄位 (null/undefined)" });
    }
    // --- [FIX] ----------------------------------

    console.log(`[CodeMate 儲存中 1/4] 收到 student ${studentId} 的作答: quizId=${quizId}, qId=${questionId}, answer=${answer}, isCorrect=${isCorrect}`);

    const newAttempt = new QuizAttempt({
      studentId,
      quizId,
      questionId,
      answer,
      isCorrect,
      timestamp: new Date()
    });

    try {
      await newAttempt.save();
      console.log(`[CodeMate 儲存中 2/4] Mongoose .save() 成功!`);
    } catch (saveError) {
      // --- [FIX] 這就是我們需要看的錯誤！ ---
      console.error(`[CodeMate 儲存中 2/4] Mongoose .save() 失敗!`, saveError);
      // 將 Mongoose 的詳細錯誤回傳給前端，以便在瀏覽器 F12 中看到
      return res.status(500).json({ message: "Mongoose .save() 失敗", error: saveError.message, fullError: saveError });
    }

    // 3. 讀取所有紀錄
    const allAttempts = await QuizAttempt.find({ studentId: studentId });
    console.log(`[CodeMate 儲存中 3/4] .find() 找到了 ${allAttempts.length} 筆紀錄`);

    // 4. 重組資料
    const reconstructedQuizzes = reconstructProgress(allAttempts);
    console.log(`[CodeMate 儲存中 4/4] 重組後的資料: ${JSON.stringify(reconstructedQuizzes)}`);

    res.status(201).json({ 
      message: "作答紀錄已儲存", 
      newProgress: { 
        quizzes: reconstructedQuizzes
      } 
    });

  } catch (error) {
    console.error("儲存測驗作答的過程中發生了其他錯誤:", error);
    res.status(500).json({ message: "伺服器內部錯誤", error: error.message });
  }
});


// [GET API] 取得「所有」測驗進度 (保持不變)
app.get('/api/progress/quiz/:studentId', async (req, res) => {
  try {
    const { studentId } = req.params;
    if (!studentId) {
      return res.status(400).json({ message: '缺少學生 ID' });
    }

    const allAttempts = await QuizAttempt.find({ studentId: studentId });
    
    console.log(`[CodeMate 讀取中] 找到 student ${studentId} 的 ${allAttempts.length} 筆作答紀錄`);

    const reconstructedQuizzes = reconstructProgress(allAttempts);

    res.status(200).json({ 
      progress: { 
        quizzes: reconstructedQuizzes 
      } 
    }); 

  } catch (error) {
    console.error("讀取測驗進度時發生錯誤:", error);
    res.status(500).json({ message: '伺服器內部錯誤' });
  }
});
// --- 🔼 [FIX] ---------------------------------------------


// --- 伺服器啟動 (包含 Socket.IO) ---
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", 
    methods: ["GET", "POST"]
  }
});

io.on('connection', (socket) => {
  console.log(`[Socket.IO] 一位使用者已連線: ${socket.id}`);
  
  let pythonProcess = null; 
//const PYTHON_PATH = 'C:\\Users\\user\\AppData\\Local\\Programs\\Python\\Python311\\python.exe';

  socket.on('run_code', (code) => {
    console.log(`[Socket.IO] 收到 'run_code' 事件，程式碼長度: ${code.length}，內容: ${code.substring(0, 50)}...`);
    if (pythonProcess) {
      pythonProcess.kill('SIGKILL');
    }
    
    try {
        // 使用 -u 確保 stdout/stderr 是 unbuffered，這樣 input() 的提示才能即時送出
         pythonProcess = spawn('python3', ['-u', '-c', code], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
        console.error(`[Python Spawn Error] 啟動 Python 失敗:`, e);
        socket.emit('terminal_error', `啟動 Python 失敗: ${e.message}`);
        return;
    }

    pythonProcess.stdout.on('data', (data) => {
      const output = data.toString();
      console.log(`[Socket.IO] 正在發送 stdout 輸出 (長度: ${output.length}): ${output.substring(0, 50).replace(/\n/g, '\\n')}...`); // 新增日誌
      // 確保輸出被正確發送
      socket.emit('terminal_output', output);
      
      // 偵測 Python 的 input() 提示
      // 由於 input() 的提示會先輸出到 stdout，然後等待輸入
      // 這裡我們假設只要有輸出，且程式還在執行，就應該讓前端檢查是否需要輸入
      // 更好的做法是讓前端根據輸出內容（例如結尾是 : 或 ?）來判斷
      // 這裡不需要特別處理，因為前端已經有邏輯判斷了。
    });
    pythonProcess.stderr.on('data', (data) => {
      const output = data.toString();
      console.log(`[Socket.IO] 正在發送 stderr 輸出 (長度: ${output.length}): ${output.substring(0, 50).replace(/\n/g, '\\n')}...`); // 新增日誌
      // 錯誤輸出也應該被正確發送
      socket.emit('terminal_output', output);
    });
    pythonProcess.on('close', (code) => {
      console.log(`[Socket.IO] Python 進程已關閉，退出代碼: ${code}`);
      if (code !== 0) {
          // 如果退出代碼不是 0，我們假設這是執行錯誤或命令找不到
          // 由於 stdout/stderr 已經發送了，這裡只發送一個錯誤提示
          socket.emit('terminal_error', `程式執行失敗，退出代碼: ${code}。請檢查程式碼或環境配置。`);
      } else {
          // 正常退出 (退出代碼為 0)
          socket.emit('terminal_exit', `程式執行完畢`); // 移除退出代碼
      }
      pythonProcess = null; 
    });
    
    // 處理 stdin 關閉事件，防止程序意外退出
    pythonProcess.stdin.on('error', (err) => {
        console.error('[Python Process] stdin 錯誤:', err);
    });
    pythonProcess.on('error', (err) => {
      console.error(`[Python Spawn Error] 啟動 Python 失敗:`, err);
      socket.emit('terminal_error', `啟動 Python 失敗: ${err.message}`);
      pythonProcess = null;
    });
  });

  socket.on('terminal_input', (data) => {
    if (pythonProcess && pythonProcess.stdin) {
      pythonProcess.stdin.write(data);
    }
  });
  socket.on('stop_code', () => {
    if (pythonProcess) {
      console.log(`[Socket.IO] 收到 'stop_code' 事件，正在終止 ${socket.id} 的進程...`);
      // 使用 'SIGKILL' 強制終止訊號，這對無限迴圈最有效
      pythonProcess.kill('SIGKILL');
      pythonProcess = null; // 清理進程
      // .kill() 會自動觸發 'close' 事件
      // 'close' 事件監聽器會發送 'terminal_exit' 給前端
      // 所以我們這裡不需要額外發送事件
    } else {
      console.log(`[Socket.IO] 收到 'stop_code' 事件，但沒有正在運行的進程。`);
    }
  });

  socket.on('disconnect', () => {
    console.log(`[Socket.IO] 使用者已離線: ${socket.id}`);
    if (pythonProcess) {
      pythonProcess.kill('SIGKILL');
      console.log('[Python Process] 因連線中斷，已強制結束子進程。');
    }
  });
});

server.listen(PORT, () => {
  console.log(`🚀 伺服器正在 http://localhost:${PORT} 上運行 (已啟用 WebSocket)`);
});
