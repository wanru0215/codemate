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
// (您的 Student 和 LearningRecord schema... 保持不變)
const studentSchema = new mongoose.Schema({
  studentId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  password: { type: String, required: true },
  registrationTime: { type: Date, default: Date.now },
  lastLoginTime: { type: Date }
});
const Student = mongoose.model('Student', studentSchema, 'Students');

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

// 單次作答紀錄的子 Schema
const AttemptSchema = new mongoose.Schema({
  answer: { type: String, required: true },
  isCorrect: { type: Boolean, required: true },
  timestamp: { type: Date, default: Date.now }
}, { _id: false }); // _id: false 因為這是內嵌陣列

// 單一問題進度的子 Schema
const QuestionProgressSchema = new mongoose.Schema({
  questionId: { type: String, required: true },
  attempts: [AttemptSchema], // 儲存該問題的所有作答紀錄
  correctCount: { type: Number, default: 0 },
  incorrectCount: { type: Number, default: 0 }
}, { _id: false });

// 單一測驗進度的子 Schema
const QuizProgressSchema = new mongoose.Schema({
  quizId: { type: String, required: true },
  lastAttempted: { type: Date, default: Date.now },
  // 使用 Map (Mongoose 6+ 功能) 來儲存 "q1" -> QuestionProgress
  questions: {
    type: Map,
    of: QuestionProgressSchema,
    default: {}
  }
}, { _id: false });

// 學習進度 (主 Collection)
const learningProgressSchema = new mongoose.Schema({
  studentId: { 
    type: String, 
    required: true, 
    unique: true, 
    index: true 
    // 您也可以使用: type: mongoose.Schema.Types.ObjectId, ref: 'Student'
    // 但使用 studentId (String) 會讓 API 呼叫更直接
  },
  // 使用 Map 儲存 "1014" (quizId) -> QuizProgress
  quizzes: {
    type: Map,
    of: QuizProgressSchema,
    default: {}
  }
});
const LearningProgress = mongoose.model('LearningProgress', learningProgressSchema, 'LearningProgress');

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
    const modelName = "gemini-2.5-flash";
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

// 取得對話紀錄 API (保持不變)
app.get('/api/log/conversation/:studentId', async (req, res) => {
  try {
    const { studentId } = req.params;
    if (!studentId) {
      return res.status(400).json({ message: '缺少學生 ID' });
    }
    const record = await LearningRecord.findOne(
        { studentId },
        { conversation: { $slice: -50 } }
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

// [新 API] 提交「單一」測驗答案
// 這是前端「每按一題」就會呼叫的 API
app.post('/api/progress/quiz/attempt', async (req, res) => {
  try {
    const { studentId, quizId, questionId, answer, isCorrect } = req.body;
    
    if (!studentId || !quizId || !questionId || !answer || isCorrect === undefined) {
      return res.status(400).json({ message: "缺少必要的提交欄位" });
    }

    // 1. 找到 (或建立) 該學生的學習進度文件
    let progressDoc = await LearningProgress.findOne({ studentId: studentId });
    if (!progressDoc) {
      progressDoc = new LearningProgress({ studentId: studentId, quizzes: new Map() });
    }

    // 2. 找到 (或建立) 該測驗的進度
    if (!progressDoc.quizzes.has(quizId)) {
      progressDoc.quizzes.set(quizId, { quizId: quizId, questions: new Map() });
    }
    const quizProgress = progressDoc.quizzes.get(quizId);

    // 3. 找到 (或建立) 該問題的進度
    if (!quizProgress.questions.has(questionId)) {
      quizProgress.questions.set(questionId, { 
        questionId: questionId, 
        attempts: [], 
        correctCount: 0, 
        incorrectCount: 0 
      });
    }
    const questionProgress = quizProgress.questions.get(questionId);

    // 4. 新增這次的作答紀錄
    const newAttempt = {
      answer: answer,
      isCorrect: isCorrect,
      timestamp: new Date()
    };
    questionProgress.attempts.push(newAttempt);

    // 5. 更新統計數據和時間
    if (isCorrect) {
      questionProgress.correctCount += 1;
    } else {
      questionProgress.incorrectCount += 1;
    }
    quizProgress.lastAttempted = new Date();
    
    // 6. 儲存回資料庫
    // Mongoose Map 需要這樣標記為 'modified' 才能正確儲存
    progressDoc.markModified('quizzes'); 
    await progressDoc.save();

    res.status(201).json({ message: "作答紀錄已儲存", newProgress: progressDoc });

  } catch (error) {
    console.error("儲存測驗作答時發生錯誤:", error);
    res.status(500).json({ message: "伺服器內部錯誤" });
  }
});


// [修改後的 API] 取得「所有」測驗進度
app.get('/api/progress/quiz/:studentId', async (req, res) => {
  try {
    const { studentId } = req.params;
    if (!studentId) {
      return res.status(400).json({ message: '缺少學生 ID' });
    }

    // 從新的 'LearningProgress' collection 讀取
    const progressDoc = await LearningProgress.findOne({ studentId: studentId });

    if (!progressDoc) {
      // 找不到該學生的進度，回傳空物件 (這很正常)
      return res.status(200).json({ progress: { quizzes: {} } });
    }

    // 回傳前端期望的格式 { progress: { quizzes: { ... } } }
    // Mongoose Map 會自動序列化為 JS 物件
    res.status(200).json({ progress: progressDoc.toObject() }); 

  } catch (error) {
    console.error("讀取測驗進度時發生錯誤:", error);
    res.status(500).json({ message: '伺服器內部錯誤' });
  }
});

// 1. 我們使用 Node 原生的 'http' 模組來建立伺服器，並傳入 Express app
const server = http.createServer(app);

// 2. 將 socket.io 附加到這個 http 伺服器上
const io = new Server(server, {
  cors: {
    origin: "*", // 允許所有來源，在生產環境中您可能需要將其限制為您的前端網址
    methods: ["GET", "POST"]
  }
});

io.on('connection', (socket) => {
  console.log(`[Socket.IO] 一位使用者已連線: ${socket.id}`);
  
  let pythonProcess = null; // 在這個連線的範圍內儲存 Python 子進程

  // 1. 監聽來自前端的 'run_code' 事件
  socket.on('run_code', (code) => {
    console.log(`[Socket.IO] 收到 'run_code' 事件，執行程式碼: ${code.substring(0, 20)}...`);

    // 如果已有一個進程在運行，先結束它
    if (pythonProcess) {
      pythonProcess.kill('SIGKILL');
    }

    // 啟動新的 Python 子進程
    // -u (unbuffered) 參數至關重要，它能確保輸出 (print) 和輸入 (input) 提示立即被發送
    pythonProcess = spawn('python3', ['-u', '-c', code]);

    // 2. 將 Python 的標準輸出 (stdout) 轉發給前端
    pythonProcess.stdout.on('data', (data) => {
      // 'terminal_output' 是我們自訂的事件名稱，前端需要監聽它
      socket.emit('terminal_output', data.toString());
    });

    // 3. 將 Python 的標準錯誤 (stderr) 也轉發給前端
    pythonProcess.stderr.on('data', (data) => {
      // 我們也使用 'terminal_output' 來發送錯誤，這樣前端才能在同一個終端機畫面上顯示
      socket.emit('terminal_output', data.toString());
    });

    // 4. 監聽 Python 程式的結束事件
    pythonProcess.on('close', (code) => {
      socket.emit('terminal_exit', `程式執行完畢，退出代碼: ${code}`);
      pythonProcess = null; // 清理進程
    });

    // 5. 監聽 Python 啟動失敗的錯誤
    pythonProcess.on('error', (err) => {
      console.error(`[Python Spawn Error] 啟動 Python 失敗:`, err);
      socket.emit('terminal_error', `啟動 Python 失敗: ${err.message}`);
      pythonProcess = null;
    });
  });

  // 6. 監聽來自前端的 'terminal_input' 事件 (用於 input())
  socket.on('terminal_input', (data) => {
    if (pythonProcess && pythonProcess.stdin) {
      // 將前端傳來的資料寫入 Python 的標準輸入 (stdin)
      // 我們需要手動加上換行符，模擬按下 Enter 鍵
      pythonProcess.stdin.write(data + '\n');
    }
  });

  // 7. 監聽連線中斷事件
  socket.on('disconnect', () => {
    console.log(`[Socket.IO] 使用者已離線: ${socket.id}`);
    // 如果使用者關閉了瀏覽器，我們必須手動結束還在運行的 Python 程式
    if (pythonProcess) {
      pythonProcess.kill('SIGKILL');
      console.log('[Python Process] 因連線中斷，已強制結束子進程。');
    }
  });
});

// 4. 啟動伺服器 (修改為啟動 'server' 而不是 'app')
server.listen(PORT, () => {
  console.log(`🚀 伺服器正在 http://localhost:${PORT} 上運行 (已啟用 WebSocket)`);
});
