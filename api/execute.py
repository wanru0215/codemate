from flask import Flask, request

# Vercel 會自動找到這個名為 'app' 的 Flask 實例
app = Flask(__name__)

# 這裡的路由 Vercel 會忽略，它會直接使用檔案名稱作為路徑
# 所以前端請求的路徑是 /api/execute
@app.route('/api/execute', methods=['POST'])
def handle_execution():
    # 您的程式執行邏輯...
    code_to_run = request.json.get('code')
    
    # 執行程式碼... (此處省略了安全的沙箱執行細節)
    result = f"Python code '{code_to_run}' would be executed here."

    # 必須回傳一個 Response 物件
    return {"result": result}
