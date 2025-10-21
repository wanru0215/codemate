from flask import Flask, request, jsonify
import subprocess
import sys

app = Flask(__name__)

@app.route('/api/execute', methods=['POST'])
def execute_handler():
    code = request.json.get('code', '')
    if not code:
        return jsonify({"error": "No code provided"}), 400

    try:
        # 在這個 Python 環境中，sys.executable 就是 'python3'
        # 我們在這裡安全地執行 Python 程式碼
        process = subprocess.run(
            [sys.executable, '-c', code],
            capture_output=True,
            text=True,
            timeout=10
        )
        return jsonify({
            "output": process.stdout,
            "error": process.stderr
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500
