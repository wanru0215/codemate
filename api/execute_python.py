from flask import Flask, request, jsonify
import subprocess
import sys

app = Flask(__name__)

# Vercel 會將對 /api/execute_python 的請求導向這裡
@app.route('/api/execute_python', methods=['POST'])
def handler():
    # 從傳來的 JSON body 中取得 'code' 欄位
    code = request.json.get('code', '')
    if not code:
        return jsonify({"error": "沒有提供程式碼"}), 400

    output = ""
    error = ""
    try:
        # 在這個 Python Serverless 環境中執行程式碼
        # sys.executable 指向當前環境的 python 解譯器
        process = subprocess.run(
            [sys.executable, '-u', '-c', code],
            capture_output=True,
            text=True,
            timeout=10 # 設定 10 秒超時
        )
        output = process.stdout
        error = process.stderr
        
    except subprocess.TimeoutExpired:
        error = "程式執行超時 (超過 10 秒)"
    except Exception as e:
        error = f"伺服器內部錯誤: {str(e)}"

    return jsonify({"output": output, "error": error})
