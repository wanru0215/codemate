// 1. 引入需要的模組
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const { spawn } = require('child_process'); // 用於執行外部程式

// 2. 初始化 Express 應用
const app = express();
const PORT = 3000;

// 3. 設定中間件 (Middleware)
app.use(cors());
app.use(express.json());

// --- 資料庫連線 ---
const mongoURI = 'mongodb+srv://user:WXXrWGcC9Z0LiYT3@cluster0.t2r6dop.mongodb.net/SCU?retryWrites=true&w=majority';

mongoose.connect(mongoURI)
  .then(() => console.log('成功連接到 MongoDB (SCU 資料庫)'))
  .catch(err => console.error('無法連接到 MongoDB:', err));

// --- Mongoose Schema & Model ---
const studentSchema = new mongoose.Schema({
  studentId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  password: { type: String, required: true },
  registrationTime: { type: Date, default: Date.now },
  lastLoginTime: { type: Date }
});

const Student = mongoose.model('Student', studentSchema, 'Students');

// <<< --- 新增：學習紀錄的 Schema & Model --- >>>
const messageSchema = new mongoose.Schema({
    id: { type: Number, required: true },
    sender: { type: String, required: true },
    content: { type: String, required: true },
    timestamp: { type: Date, required: true },
    feedback: { type: String, enum: ['up', 'down', null], default: null } // 'up', 'down', 或未提供
}, { _id: false }); // 子文件不需要自己的 _id

const learningRecordSchema = new mongoose.Schema({
    studentId: { type: String, required: true, index: true },
    conversation: [messageSchema],
    lastUpdated: { type: Date, default: Date.now }
});

const LearningRecord = mongoose.model('LearningRecord', learningRecordSchema, 'LearningRecords');


// --- API 路由 (Routes) ---

// 註冊 API: /api/register
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

// 登入 API: /api/login
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

const fetch = require("node-fetch"); // 如果 Node 18+ 可以不用裝

// Gemini API Proxy
app.post("/api/chat", async (req, res) => {
    try {
        const apiKey = process.env.GEMINI_API_KEY; // 從 Render 環境變數讀取
        if (!apiKey) {
            return res.status(500).json({ error: "缺少 GEMINI_API_KEY 環境變數" });
        }

        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${apiKey}`;

        const response = await fetch(apiUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(req.body), // 前端傳來的 payload 原封不動傳給 Gemini
        });

        const data = await response.json();

        if (!response.ok) {
            return res.status(response.status).json(data);
        }

        res.json(data);
    } catch (err) {
        console.error("Gemini API Proxy 錯誤:", err);
        res.status(500).json({ error: "伺服器內部錯誤，無法呼叫 Gemini API" });
    }
});

// 執行程式碼 API: /api/execute
app.post('/api/execute', (req, res) => {
    const { code } = req.body;
    if (!code) {
        return res.status(400).json({ error: "沒有提供程式碼" });
    }
    const pythonProcess = spawn('python3', ['-u', '-c', code]);
    let output = '';
    let error = '';
    pythonProcess.stdout.on('data', (data) => { output += data.toString(); });
    pythonProcess.stderr.on('data', (data) => { error += data.toString(); });
    pythonProcess.on('close', (code) => {
        res.json({ output, error });
    });
    pythonProcess.on('error', (err) => {
        res.status(500).json({ error: '伺服器無法執行 Python 程式碼。' });
    });
});

// <<< --- 新增：儲存對話紀錄的 API --- >>>
app.post('/api/log/conversation', async (req, res) => {
    try {
        const { studentId, conversation } = req.body;

        if (!studentId || !Array.isArray(conversation)) {
            return res.status(400).json({ message: "缺少學生 ID 或對話內容" });
        }

        // 使用 findOneAndUpdate 搭配 upsert: true
        // 如果找到符合 studentId 的紀錄，就更新它；如果找不到，就建立一筆新的。
        await LearningRecord.findOneAndUpdate(
            { studentId: studentId },
            { 
                $set: { 
                    conversation: conversation,
                    lastUpdated: new Date()
                }
            },
            { upsert: true, new: true } // upsert: true 是關鍵
        );

        res.status(200).json({ message: "對話紀錄已成功儲存" });

    } catch (error) {
        console.error("儲存對話紀錄時發生錯誤:", error);
        res.status(500).json({ message: "伺服器內部錯誤" });
    }
});

// 4. 啟動伺服器
app.listen(PORT, () => {
  console.log(`伺服器正在 http://localhost:${PORT} 上運行`);
});

