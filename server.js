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
const fs = require('fs'); 

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

// 學生帳號 Schema
const studentSchema = new mongoose.Schema({
  studentId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  password: { type: String, required: true },
  registrationTime: { type: Date, default: Date.now },
  lastLoginTime: { type: Date }
});
const Student = mongoose.model('Student', studentSchema, 'Students');

// 對話紀錄 Schema
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
  quizzes: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  lastUpdated: { type: Date, default: Date.now }
});
const QuizProgress = mongoose.model('QuizProgress', quizProgressSchema, 'QuizProgress');

// 🔥 [修改] 學習單 Schema：加入 history 欄位儲存批改紀錄 🔥
const worksheetAnswerSchema = new mongoose.Schema({
  studentId: { type: String, required: true, unique: true, index: true },
  answers: { type: mongoose.Schema.Types.Mixed, required: true }, // 最新版答案
  history: [ // 歷史紀錄 (AI 批改存檔用)
    {
      moduleId: Number,
      timestamp: { type: Date, default: Date.now },
      answersSnapshot: Object,
      aiFeedback: String
    }
  ],
  lastUpdated: { type: Date, default: Date.now }
});
const WorksheetAnswer = mongoose.model('WorksheetAnswer', worksheetAnswerSchema, 'WorksheetAnswers');

// User Workspace Schema
const userWorkspaceSchema = new mongoose.Schema({
  studentId: { type: String, required: true, unique: true },
  tabs: { type: Array, default: [] }, 
  activeTabId: { type: Number },      
  lastCourseId: { type: Number },     
  lastModuleId: { type: Number },     
  lastUpdated: { type: Date, default: Date.now }
});
const UserWorkspace = mongoose.model('UserWorkspace', userWorkspaceSchema, 'UserWorkspaces');

// --- API 路由 (Routes) ---

// 🔥 [新增] AI 批改 API 🔥
app.post('/api/progress/worksheet/grade', async (req, res) => {
  try {
    const { studentId, moduleId, currentAnswers, contextData } = req.body;

    if (!studentId || !moduleId || !contextData) {
      return res.status(400).json({ message: '缺少必要資料' });
    }

    // A. 準備 Prompt 呼叫 Gemini
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.error("缺少 GEMINI_API_KEY");
        return res.status(500).json({ message: '伺服器配置錯誤: 缺少 API Key' });
    }

    const modelName = "gemini-2.0-flash";
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

    const titleInfo = chapterTitle ? `${chapterTitle} (ID: ${moduleId})` : `章節 ID ${moduleId}`;
    const systemPrompt = `
      你是一位 Python 程式設計老師。學生剛剛完成了章節 ID ${moduleId} 的運算思維學習單。
      以下是題目與學生目前的作答內容。
      
      請針對學生的作答給予「批改建議」：
      1. 指出哪些回答是正確的，給予肯定。
      2. 指出哪些回答有誤或不精確，並引導學生思考正確方向（不要直接給答案）。
      3. 語氣要鼓勵且友善。
      4. 請用繁體中文回答。
      5. 請使用 Markdown 格式 (例如列點、粗體)。
      
      學生的作答資料如下：
      ${contextData}
    `;

    const payload = {
      contents: [{ role: 'user', parts: [{ text: systemPrompt }] }]
    };

    // 呼叫 Gemini
    const geminiResponse = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    
    if (!geminiResponse.ok) {
        const errData = await geminiResponse.text();
        console.error("Gemini API Error:", errData);
        throw new Error("Gemini API 呼叫失敗");
    }

    const data = await geminiResponse.json();
    const aiFeedback = data.candidates?.[0]?.content?.parts?.[0]?.text || "AI 目前無法提供建議。";

    // B. 存檔：將「當下版本」與「AI 建議」存入 history
    await WorksheetAnswer.findOneAndUpdate(
      { studentId: studentId },
      { 
        $push: { 
          history: {
            moduleId: moduleId,
            timestamp: new Date(),
            answersSnapshot: currentAnswers, // 儲存按下按鈕當下的答案版本
            aiFeedback: aiFeedback
          }
        },
        $set: { lastUpdated: new Date() } // 同時更新最後時間
      },
      { upsert: true, new: true }
    );

    // C. 回傳 AI 建議給前端顯示
    res.status(200).json({ feedback: aiFeedback });

  } catch (error) {
    console.error('AI 批改 API 錯誤:', error);
    res.status(500).json({ message: '伺服器錯誤，無法取得 AI 建議' });
  }
});

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
      res.status(200).json({}); 
    }
  } catch (error) {
    console.error('載入學習單答案時發生錯誤:', error);
    res.status(500).json({ message: '伺服器內部錯誤' });
  }
});

// Workspace API (儲存/讀取 Tabs)
app.post('/api/workspace/save', async (req, res) => {
  try {
    const { studentId, tabs, activeTabId, lastCourseId, lastModuleId } = req.body;
    
    if (!studentId) {
      return res.status(400).json({ message: "Missing studentId" });
    }

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

app.get('/api/workspace/load/:studentId', async (req, res) => {
  try {
    const { studentId } = req.params;
    const data = await UserWorkspace.findOne({ studentId });
    res.json(data || {}); 
  } catch (err) {
    console.error("讀取 Workspace 失敗:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// 註冊 API
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

// 登入 API
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

// Gemini API 代理
app.post("/api/chat", async (req, res) => {
  console.log("1. [API Chat] 收到前端個人化請求...");

  try {
    const { contents, systemInstruction, studentId } = req.body;

    if (!studentId || !contents) {
        return res.status(400).json({ error: { message: "請求中缺少 studentId 或 contents" } });
    }

    const record = await LearningRecord.findOne({ studentId });
    const fullHistory = record?.conversation || [];
    const fewShotExamples = [];
    if (fullHistory.length > 1) {
        let pairsFound = 0;
        for (let i = fullHistory.length - 1; i > 0 && pairsFound < 2; i--) {
            if (fullHistory[i].sender === 'user' && fullHistory[i-1].sender === 'ai') {
                fewShotExamples.unshift({ role: 'model', parts: [{ text: fullHistory[i-1].content }] });
                fewShotExamples.unshift({ role: 'user', parts: [{ text: fullHistory[i].content }] });
                pairsFound++;
            }
        }
    }

    const finalContents = [
        ...fewShotExamples,
        ...contents
    ];
    
    const finalPayload = {
        contents: finalContents,
        systemInstruction: systemInstruction
    };

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: { message: "伺服器缺少 GEMINI_API_KEY" } });
    }
    const modelName = "gemini-2.0-flash";
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

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
    
    res.json(data);

  } catch (err) {
    console.error("6. [API Chat] 代理請求過程中發生嚴重錯誤:", err);
    res.status(500).json({ error: { message: "伺服器內部錯誤，無法呼叫 Gemini API" } });
  }
});

// 儲存對話紀錄 API
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

// 取得對話紀錄 API
app.get('/api/log/conversation/:studentId', async (req, res) => {
  try {
    const { studentId } = req.params;
    if (!studentId) {
      return res.status(400).json({ message: '缺少學生 ID' });
    }
    const record = await LearningRecord.findOne(
        { studentId },
        { conversation: { $slice: -30 } } 
    );

    if (record && record.conversation) {
      res.status(200).json(record.conversation);
    } else {
      res.status(200).json([]); 
    }
  } catch (error) {
    console.error("讀取對話紀錄時發生錯誤:", error);
    res.status(500).json({ message: '伺服器內部錯誤' });
  }
});

app.post('/api/progress/quiz/attempt', async (req, res) => {
    const { studentId, quizId, questionId, answer, isCorrect } = req.body;

    if (!studentId || !quizId || !questionId) {
      return res.status(400).json({ message: "缺少必要欄位" });
    }

    const update = {
      [`quizzes.${quizId}.${questionId}`]: {
        answer,
        isCorrect,
        timestamp: new Date()
      },
      lastUpdated: new Date()
    };

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

io.on('connection', (socket) => {
  console.log(`[Socket.IO] 一位使用者已連線: ${socket.id}`);
  
  let pythonProcess = null; 

  // --- 🛡️ 修正後的 run_code (含安全沙箱機制) ---
  socket.on('run_code', (code) => {
    console.log(`[Socket.IO] 收到 'run_code' 事件`);

    // 1. 確保有一個獨立的執行資料夾 (Sandbox Directory)
    const workspaceDir = path.join(__dirname, 'temp_workspace');
    if (!fs.existsSync(workspaceDir)){
        try {
            fs.mkdirSync(workspaceDir);
        } catch (e) {
            console.error("建立暫存資料夾失敗:", e);
        }
    }

    // 2. 注入 Python 安全前置碼 (Security Preamble)
    const securityPreamble = `
import sys
import os
import builtins

# --- 禁用危險模組 ---
sys.modules['shutil'] = None 

# --- 限制 os 功能 ---
if hasattr(os, 'remove'): os.remove = lambda *args, **kwargs: print("⚠️ 安全警告: 刪除檔案功能(os.remove)已被禁用。")
if hasattr(os, 'rmdir'): os.rmdir = lambda *args, **kwargs: print("⚠️ 安全警告: 刪除目錄功能(os.rmdir)已被禁用。")
if hasattr(os, 'unlink'): os.unlink = lambda *args, **kwargs: print("⚠️ 安全警告: 刪除連結功能(os.unlink)已被禁用。")

# --- 限制 open 功能 (防止目錄遍歷攻擊) ---
original_open = builtins.open

def safe_open(file, mode='r', *args, **kwargs):
    str_file = str(file)
    # 禁止使用 '../' 或絕對路徑
    if '..' in str_file or str_file.startswith('/') or ':' in str_file:
        raise PermissionError(f"⚠️ 安全警告: 存取受限。您只能在當前目錄下讀寫檔案，禁止使用 '../' 或絕對路徑。")
    return original_open(file, mode, *args, **kwargs)

builtins.open = safe_open
# ---------------------------
`;

    const finalCode = securityPreamble + "\n" + code;

    // 清理舊程序
    if (pythonProcess) {
      pythonProcess.kill('SIGKILL');
    }

    // 3. 執行 Python (設定 cwd 為 workspaceDir)
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
  // ------------------------------------------------

  socket.on('terminal_input', (data) => {
    if (pythonProcess && pythonProcess.stdin) {
      pythonProcess.stdin.write(data + '\n');
    }
  });
  
  socket.on('stop_code', () => {
    if (pythonProcess) {
      console.log(`[Socket.IO] 收到 'stop_code' 事件，正在終止 ${socket.id} 的進程...`);
      pythonProcess.kill('SIGKILL');
      pythonProcess = null; 
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
