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
// 定義學習進度順序，用於限制 AI 建議範圍
const ID_NAME_MAP = {
    "1015": "第一章：Python 的基本觀念",
    "1026": "第二章：變數與數學運算",
    "1037": "第三章：Python 的基本資料型態",
    "1047": "第四章：基本輸入與輸出",
    "1056": "第五章：流程控制 (if)",
    "10612": "第六章：串列 (List)",
    "10711": "第七章：迴圈 (Loop)",
    "1098": "第九章：字典 (Dict)",
    "2015": "第十章：集合 (Set)",
    "20211": "第十一章：函數 (Function)",
    "20310": "第十二章：類別 (Class)",
    "20413": "第十四章：檔案讀寫",
    "2056": "第十五章：異常處理 (Try-Except)"
};
const CHAPTER_SEQUENCE = ["1015", "1026", "1037", "1047", "1056", "10612", "10711", "1098", "2015", "20211", "20310", "20413", "2056"];

app.post('/api/progress/worksheet/grade', async (req, res) => {
  try {
    const { studentId, moduleId, chapterTitle, currentAnswers, contextData } = req.body;

    if (!studentId || !moduleId || !contextData) {
      return res.status(400).json({ message: '缺少必要資料' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    const modIdStr = String(moduleId);
    const currentIndex = CHAPTER_SEQUENCE.indexOf(modIdStr);
    
    const allowedChaptersNames = CHAPTER_SEQUENCE
        .slice(0, currentIndex + 1)
        .map(id => ID_NAME_MAP[id] || id);

    // --- 1. 整合您原本的詳細題庫資訊 ---
    let correctAnswerInfo = "";
    if (modIdStr === "1015") {
        correctAnswerInfo = `【標準解答】：1.抽象化 2.直譯式 3.動態型別 4.# 5.演算法`;
    } else if (modIdStr === "1026") {
        correctAnswerInfo = `【題目背景】：薪資管理員。180*156=28080元。限制：僅限千元、百元、十元面額。禁止建議 500/50/5/1 元。重點：檢查 // 與 % 運算。`;
    } else if (modIdStr === "1037") {
        correctAnswerInfo = `【規則】：一杯50元，總額 > 200 為大額訂單。重點：input() 轉型 int()、if 判斷、輸出總金額。`;
    } else if (modIdStr === "1047") {
        correctAnswerInfo = `【排版限制】：用 "|" 分隔。名稱佔15字元靠左({:<15})，價格佔10字元靠右並小數兩位({:>10.2f})。`;
    } else if (modIdStr === "1056") {
        correctAnswerInfo = `【等級標準】：90:A, 80:B, 70:C, 60:D, F。例外：>100或<0顯示「分數輸入錯誤」。重點：if-elif-else 結構。`;
    } else if (modIdStr === "10612") {
        correctAnswerInfo = `【任務】：初始5人、append()新增、pop()或remove()刪除最後、max()最高分、sort(reverse=True)排序。`;
    } else if (modIdStr === "10711") {
        correctAnswerInfo = `【規則】：random 產生 1-100、限猜5次、提示大小、猜中 break、失敗顯示挑戰失敗。`;
    } else if (modIdStr === "1098") {
        correctAnswerInfo = `【功能】：建立3人字典、Key(姓名)取Value(電話)、修改與新增 Key-Value。`;
    } else if (modIdStr === "2015") {
        correctAnswerInfo = `【解答】：報名{Amy,Bob,Cathy,Dave}, 簽到{Amy,Bob,Eve}。有效出席(交集&):{Amy,Bob}, 缺席(差集-):{Cathy,Dave}。`;
    } else if (modIdStr === "20211") {
        correctAnswerInfo = `【邏輯】：紅茶/綠茶30, 奶茶50。珍珠+10, 椰果+5。必須 return 總金額。重點：def 與 return。`;
    } else if (modIdStr === "20310") {
        correctAnswerInfo = `【邏輯】：Class Pet, __init__ 預設 hunger=50, play() +20, feed() -10。實作 Pikachu 最終值應為 60。`;
    } else if (modIdStr === "20413") {
        correctAnswerInfo = `【流程】：寫入 scores.txt (80,60,45,90,100)、讀取計算平均(75.0)、寫入 report.txt。重點：with open, 'r'/'w'模式。`;
    } else if (modIdStr === "2056") {
        correctAnswerInfo = `【要求】：捕捉 ValueError (非數字) 與 ZeroDivisionError (除以0)。重點：try-except 結構。`;
    }

    // --- 2. 整合評分標準樣版 ---
    let gradingRubric = "";
    if (modIdStr === "1015") {
      gradingRubric = `【評分標準：填空題每題 20 分】請嚴格對照標準解答批改學生 q1 ~ q5 的回答。`;
    } else {
      gradingRubric = `
      【評分標準：五大任務各佔 20 分】
      1. 任務一：問題拆解 (Decomposition) - 對應 q1-1, q1-2, q1-3。須列出至少 4 個核心步驟。
      2. 任務二：樣式辨識 (Pattern Recognition) - 對應 q2-1, q2-2, q2-3。須識別重複任務或相似經驗。
      3. 任務三：抽象化 (Abstraction) - 對應 q3-1, q3-2, q3-3, q3-4。須正確設計輸入/輸出/變數。
      4. 任務四：邏輯規劃 (Algorithm Design) - 對應 q4-1。步驟須符合「${correctAnswerInfo}」中的邏輯。
      5. 任務五：例外處理 (Robustness) - 對應 q4-2。須考慮無效數據處理，否則最高僅給 10 分。`;
    }

    // --- 3. 組合最終系統 Prompt ---
    const systemPrompt = `
      你是一位 Python 教學助教，現在要批改學生的「${chapterTitle}」學習單。
      
      【知識權限規範】
      1. 學生目前的學習進度僅至：${ID_NAME_MAP[modIdStr]}。
      2. 你在建議時，只能引用以下已學過的單元概念：${allowedChaptersNames.join('、')}。
      3. **🚨 絕對禁止在回覆中出現任何四位數的 ID 編號 (如 1015, 1026, 1037 等)**。這些是系統內部編號，學生看不懂。
      4. 如果要引用章節，請直接使用名稱，例如「請參考第二章關於數學運算的內容」。

      ${gradingRubric}
      ${correctAnswerInfo}

      【回饋格式要求】
      1. 第一行必須是： 「### 總分：[計算後的分數]/100」
      2. 指出正確處給予肯定。
      3. 針對錯誤，請用「蘇格拉底引導式提問」讓學生自己發現問題，不要直接給答案。
      4. 繁體中文回答，Markdown 格式。

      【學生作答內容】
      ${contextData}
    `;

    // 呼叫 Gemini (保持原本 fetch 邏輯)
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: systemPrompt }] }] })
    });

    const data = await response.json();
    const aiFeedback = data.candidates?.[0]?.content?.parts?.[0]?.text || "無法生成建議。";

    // 🔥 儲存到 DB (同時更新 answers 以修復之前提到的遺失問題)
    // 🔥 修改後的儲存邏輯
    await WorksheetAnswer.findOneAndUpdate(
      { studentId: studentId },
      { 
        $push: { 
          history: { 
            moduleId, 
            timestamp: new Date(), 
            answersSnapshot: currentAnswers, 
            aiFeedback 
          } 
        },
        // ✅ 修正重點：使用 [`answers.${moduleId}`] 只更新當前單元 ID 的內容
        $set: { 
          [`answers.${moduleId}`]: currentAnswers, 
          lastUpdated: new Date() 
        } 
      },
      { upsert: true, new: true }
    );

    res.status(200).json({ feedback: aiFeedback });

  } catch (error) {
    console.error("批改出錯:", error);
    res.status(500).json({ message: '伺服器出錯' });
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
app.get('/api/admin/force-refresh-all', (req, res) => {
    console.log("【管理員指令】強制所有在線頁面重新整理...");
    io.emit('force_refresh'); // 向所有連接中的瀏覽器廣播刷新指令
    res.send("已成功發送全體刷新指令");
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
// 忘記密碼 API
app.post('/api/reset-password', async (req, res) => {
  try {
    const { studentId, name, newPassword } = req.body;
    
    if (!studentId || !name || !newPassword) {
      return res.status(400).json({ message: '學號、姓名和新密碼為必填' });
    }

    // 核對學號與姓名是否吻合（安全驗證）
    const student = await Student.findOne({ studentId, name });
    if (!student) {
      return res.status(404).json({ message: '找不到此學生或姓名不符，請確認輸入正確' });
    }

    // 重新雜湊(Hash)新密碼並存檔
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);
    student.password = hashedPassword;
    await student.save();

    res.status(200).json({ message: '密碼重設成功，請使用新密碼登入' });
  } catch (error) {
    console.error('重設密碼錯誤:', error);
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
  server.js 測試代碼
  const testTargetTime = new Date('3026-04-10T00:00:00+08:00').getTime();
  const currentTime = Date.now();
  const delay = testTargetTime - currentTime;
  
  if (delay > 0) {
      console.log(`測試啟動：將在 ${delay / 1000} 秒後觸發刷新...`);
      setTimeout(() => {
          console.log("到達測試時間，執行自動刷新廣播！");
          io.emit('force_refresh'); 
      }, delay);
  }

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
