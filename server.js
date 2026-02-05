// 1. 引入需要的模組
require('dotenv').config();
const fs = require('fs');
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

const quizProgressSchema = new mongoose.Schema({
  studentId: { type: String, required: true, unique: true },

  // quizzes = { '1014': { 'q1-1': {...}, 'q1-2': {...} }, ... }
  quizzes: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },

  lastUpdated: { type: Date, default: Date.now }
});

const QuizProgress = mongoose.model('QuizProgress', quizProgressSchema, 'QuizProgress');

// 學習單答案 Schema (新的結構)
const worksheetAnswerSchema = new mongoose.Schema({
  studentId: { type: String, required: true, unique: true, index: true },
  // answers 儲存 { moduleId: { qId: answer } } 結構
  answers: { type: mongoose.Schema.Types.Mixed, required: true }, 
  lastUpdated: { type: Date, default: Date.now }
});
const WorksheetAnswer = mongoose.model('WorksheetAnswer', worksheetAnswerSchema, 'WorksheetAnswers');

// --- 🔽 [新增] User Workspace Schema (儲存 Tabs 狀態) ---
const userWorkspaceSchema = new mongoose.Schema({
  studentId: { type: String, required: true, unique: true },
  tabs: { type: Array, default: [] }, // 這裡會儲存所有的 Code 和 Note 分頁
  activeTabId: { type: Number },      // 紀錄最後選中的分頁
  lastCourseId: { type: Number },     // 紀錄最後所在的課程
  lastModuleId: { type: Number },     // 紀錄最後所在的單元
  lastUpdated: { type: Date, default: Date.now }
});
const UserWorkspace = mongoose.model('UserWorkspace', userWorkspaceSchema, 'UserWorkspaces');
// --- 🔼 ----------------------------------------------
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

// 儲存學習單答案 API
app.post('/api/progress/worksheet/save', async (req, res) => {
  try {
    const { studentId, worksheetAnswers } = req.body;
    if (!studentId || !worksheetAnswers) {
      return res.status(400).json({ message: '儲存失敗：缺少學生 ID 或學習單答案' });
    }

    await WorksheetAnswer.findOneAndUpdate(
      { studentId: studentId },
      { $set: { answers: worksheetAnswers, lastUpdated: new Date() } },
      { upsert: true, new: true }
    );

    res.status(200).json({ message: '學習單答案已成功儲存到 MongoDB' });
  } catch (error) {
    console.error('儲存學習單答案時發生錯誤:', error);
    res.status(500).json({ message: '伺服器內部錯誤' });
  }
});

// 取得學習單答案 API
app.get('/api/progress/worksheet/load/:studentId', async (req, res) => {
  try {
    const { studentId } = req.params;
    if (!studentId) {
      return res.status(400).json({ message: '載入失敗：缺少學生 ID' });
    }

    const record = await WorksheetAnswer.findOne({ studentId: studentId });

    if (record && record.answers) {
      res.status(200).json(record.answers);
    } else {
      res.status(200).json({}); // 如果沒有紀錄，回傳空物件
    }
  } catch (error) {
    console.error('載入學習單答案時發生錯誤:', error);
    res.status(500).json({ message: '伺服器內部錯誤' });
  }
});
// --- 🔽 [新增] Workspace API (儲存/讀取 Tabs) ---

// A. 儲存工作區狀態 (包含所有 Tabs)
app.post('/api/workspace/save', async (req, res) => {
  try {
    const { studentId, tabs, activeTabId, lastCourseId, lastModuleId } = req.body;
    
    if (!studentId) {
      return res.status(400).json({ message: "Missing studentId" });
    }

    // 使用 findOneAndUpdate + upsert：如果資料不存在就新增，存在就更新
    await UserWorkspace.findOneAndUpdate(
      { studentId },
      { 
        $set: { 
          tabs, 
          activeTabId, 
          lastCourseId, 
          lastModuleId, 
          lastUpdated: new Date() 
        } 
      },
      { upsert: true, new: true }
    );

    res.json({ message: "Workspace saved successfully" });

  } catch (err) {
    console.error("儲存 Workspace 失敗:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// B. 讀取工作區狀態
app.get('/api/workspace/load/:studentId', async (req, res) => {
  try {
    const { studentId } = req.params;
    const data = await UserWorkspace.findOne({ studentId });
    // 如果找不到資料 (null)，回傳空物件，前端會處理預設值
    res.json(data || {}); 
  } catch (err) {
    console.error("讀取 Workspace 失敗:", err);
    res.status(500).json({ message: "Server error" });
  }
});
// --- 🔼 ----------------------------------------------
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
    const modelName = "gemini-2.0-flash";
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
        { conversation: { $slice: -30 } } // 只取最後 30 筆
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

app.post('/api/progress/quiz/attempt', async (req, res) => {
    const { studentId, quizId, questionId, answer, isCorrect } = req.body;

    if (!studentId || !quizId || !questionId) {
      return res.status(400).json({ message: "缺少必要欄位" });
    }

    // 建立存放格式
    const update = {
      [`quizzes.${quizId}.${questionId}`]: {
        answer,
        isCorrect,
        timestamp: new Date()
      },
      lastUpdated: new Date()
    };

    // upsert: true → 如果 student 沒有紀錄就建立新的 document
    const record = await QuizProgress.findOneAndUpdate(
      { studentId },
      { $set: update },
      { upsert: true, new: true }
    );

    res.status(200).json({
    message: "作答已儲存",
    progress: {
      quizzes: record.quizzes
      }
    });
});

app.get('/api/progress/quiz/:studentId', async (req, res) => {
  try {
    const { studentId } = req.params;

    const record = await QuizProgress.findOne({ studentId });

    res.status(200).json({
      progress: {
        quizzes: record ? record.quizzes : {}
      }
    });

  } catch (error) {
    console.error("讀取測驗進度時發生錯誤:", error);
    res.status(500).json({ message: '伺服器內部錯誤' });
  }
});

// --- 伺服器啟動 (包含 Socket.IO) ---
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", 
    methods: ["GET", "POST"]
  }
});

socket.on('run_code', (code) => {
    console.log(`[Socket.IO] 收到 'run_code' 事件`);
    
    // --- 🛡️ 安全防護措施 Start ---

    // 1. 確保有一個獨立的執行資料夾 (Sandbox Directory)
    // 這樣學生的檔案操作只會發生在這個資料夾內，不會影響外部專案
    const workspaceDir = path.join(__dirname, 'temp_workspace');
    if (!fs.existsSync(workspaceDir)){
        fs.mkdirSync(workspaceDir);
    }

    // 2. 注入 Python 安全前置碼 (Security Preamble)
    // 這段 Python 程式碼會跑在學生程式碼之前，用來禁用危險功能
    const securityPreamble = `
import sys
import os
import builtins

# --- 禁用危險模組 ---
# 將 shutil 設為 None，這樣 'import shutil' 就會失敗
sys.modules['shutil'] = None 

# --- 限制 os 功能 ---
# 禁用刪除檔案與目錄的功能
if hasattr(os, 'remove'): os.remove = lambda *args, **kwargs: print("⚠️ 安全警告: 刪除檔案功能(os.remove)已被禁用。")
if hasattr(os, 'rmdir'): os.rmdir = lambda *args, **kwargs: print("⚠️ 安全警告: 刪除目錄功能(os.rmdir)已被禁用。")
if hasattr(os, 'unlink'): os.unlink = lambda *args, **kwargs: print("⚠️ 安全警告: 刪除連結功能(os.unlink)已被禁用。")

# --- 限制 open 功能 (防止目錄遍歷攻擊) ---
# 這是為了讓 Ch14 仍能運作，但防止學生讀取/寫入 '../' (上一層) 或絕對路徑
original_open = builtins.open

def safe_open(file, mode='r', *args, **kwargs):
    # 如果檔名包含 '..' 或以 '/' 開頭 (Linux絕對路徑) 或雖是 Windows 但包含冒號 (如 C:)，則禁止
    str_file = str(file)
    if '..' in str_file or str_file.startswith('/') or ':' in str_file:
        raise PermissionError(f"⚠️ 安全警告: 存取受限。您只能在當前目錄下讀寫檔案，禁止使用 '../' 或絕對路徑。")
    return original_open(file, mode, *args, **kwargs)

# 覆蓋內建的 open 函式
builtins.open = safe_open
# ---------------------------

`;

    // 將安全碼與學生的程式碼合併
    const finalCode = securityPreamble + "\n" + code;

    // --- 🛡️ 安全防護措施 End ---


    if (pythonProcess) {
      pythonProcess.kill('SIGKILL');
    }

    // 3. 修改 spawn 選項：設定 cwd (Current Working Directory)
    // 讓 Python 認為自己是在 'temp_workspace' 資料夾裡運作
    pythonProcess = spawn('python3', ['-u', '-c', finalCode], { cwd: workspaceDir });

    pythonProcess.stdout.on('data', (data) => {
      socket.emit('terminal_output', data.toString());
    });
    pythonProcess.stderr.on('data', (data) => {
      socket.emit('terminal_output', data.toString());
    });
    pythonProcess.on('close', (code) => {
      socket.emit('terminal_exit', null);
      pythonProcess = null;
    });
    pythonProcess.on('error', (err) => {
      console.error(`[Python Spawn Error] 啟動 Python 失敗:`, err);
      socket.emit('terminal_error', `啟動 Python 失敗: ${err.message}`);
      pythonProcess = null;
    });
  });

  socket.on('terminal_input', (data) => {
    if (pythonProcess && pythonProcess.stdin) {
      pythonProcess.stdin.write(data + '\n');
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
