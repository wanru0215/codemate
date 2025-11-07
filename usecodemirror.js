/**
 * useCodeMirror.js (優化後版本 - 保持與您提供的版本一致，但強調 options 的傳入)
 * 
 * 這是將 CodeMirror 封裝成 React Custom Hook 的範例。
 * 
 * @param {object} props
 * @param {string} props.initialContent - 要顯示的初始內容
 * @param {function(string): void} props.onChange - 內容變更時的回調函數
 * @param {function(CodeMirror, Event): void} props.onKeyDown - 鍵盤事件的回調函數
 * @param {object} props.options - CodeMirror 的配置選項 (關鍵：從外部傳入)
 * @returns {[React.RefObject<HTMLTextAreaElement>, CodeMirror.Editor]} - [DOM Ref, CodeMirror 實例]
 */
function useCodeMirror({ initialContent, onChange, onKeyDown, options }) {
    const editorRef = React.useRef(null);
    const cmInstance = React.useRef(null);
    const contentRef = React.useRef(initialContent); // 追蹤最新的內容，避免閉包問題

    // 1. 初始化 CodeMirror 實例 (只執行一次)
    React.useEffect(() => {
        if (editorRef.current && !cmInstance.current) {
            // 使用傳入的 options 來初始化 CodeMirror
            const cm = window.CodeMirror.fromTextArea(editorRef.current, options);
            cmInstance.current = cm;

            // 綁定 change 事件
            cm.on('change', (instance) => {
                const newContent = instance.getValue();
                contentRef.current = newContent; // 更新 Ref
                onChange(newContent);
            });
            
            // 綁定 keydown 事件
            cm.on('keydown', (instance, event) => {
                onKeyDown(instance, event);
            });
        }

        // 清理函數：銷毀 CodeMirror 實例
        return () => {
            if (cmInstance.current) {
                cmInstance.current.toTextArea();
                cmInstance.current = null;
            }
        };
    }, [options]); // 依賴項只包含 options，確保只執行一次

    // 2. 同步外部內容 (當 initialContent 改變時)
    React.useEffect(() => {
        const cm = cmInstance.current;
        if (cm && initialContent !== contentRef.current) {
            // 暫時移除 change 監聽器，防止 setValue 觸發 onChange
            const changeHandler = cm.getOption('onChange');
            cm.off('change', changeHandler);
            
            // 設定新值
            cm.setValue(initialContent);
            contentRef.current = initialContent; // 更新 Ref
            
            // 重新綁定 change 監聽器
            cm.on('change', changeHandler);
            
            // 恢復游標位置和焦點
            const cursor = cm.getCursor();
            try {
                cm.setCursor(cursor);
            } catch (e) {
                cm.setCursor(cm.lineCount(), 0);
            }
            setTimeout(() => cm.focus(), 0);
        }
    }, [initialContent]);

    return [editorRef, cmInstance.current];
}


/**
 * CodeMirrorEditor 元件 (優化後版本 - 接受 options 作為 props)
 * 
 * @param {object} props
 * @param {object} props.activeTab - 當前活躍的 Tab 物件
 * @param {function(number, string): void} props.handleTabContentChange - 處理內容變更的回調
 * @param {function(CodeMirror, Event, number): void} props.handleCodeKeyDown - 處理鍵盤事件的回調
 * @param {object} [props.options] - CodeMirror 的配置選項 (新增：允許外部傳入)
 */
function CodeMirrorEditor({ activeTab, handleTabContentChange, handleCodeKeyDown, options }) {
    
    // 確保 activeTabId 在 onKeyDown 中可用
    const handleKeyDownWrapper = React.useCallback((cm, event) => {
        if (activeTab) {
            handleCodeKeyDown(cm, event, activeTab.id);
        }
    }, [activeTab, handleCodeKeyDown]);

    // 確保 handleTabContentChange 函數是穩定的
    const handleChangeWrapper = React.useCallback((newContent) => {
        if (activeTab) {
            handleTabContentChange(activeTab.id, newContent);
        }
    }, [activeTab, handleTabContentChange]);

    // 定義預設選項，並與外部傳入的 options 合併
    const defaultOptions = React.useMemo(() => ({
        mode: "python", // 預設值
        theme: "dracula", // 預設值
        lineNumbers: true,
        indentUnit: 4,
        tabSize: 4,
        autoCloseBrackets: true,
        matchBrackets: true,
        ...(options || {}) // 外部傳入的選項會覆蓋預設值
    }), [options]);


    const [editorRef, cm] = useCodeMirror({
        initialContent: activeTab?.content || '',
        onChange: handleChangeWrapper,
        onKeyDown: handleKeyDownWrapper,
        options: defaultOptions // 使用合併後的選項
    });

    // 確保在沒有 activeTab 時清空內容
    React.useEffect(() => {
        if (cm && !activeTab) {
            cm.setValue('');
        }
    }, [cm, activeTab]);

    return (
        <textarea ref={editorRef} style={{ display: 'none' }} />
    );
}

// 範例：如何在父元件中使用 CodeMirrorEditor 並傳入不同的選項
/*
function ParentComponent() {
    // ... state and handlers ...

    // 針對 Python 檔案的選項
    const pythonOptions = {
        mode: "python",
        theme: "dracula",
        // ... 其他 Python 特有的設定
    };

    // 針對 JavaScript 檔案的選項
    const jsOptions = {
        mode: "javascript",
        theme: "monokai",
        // ... 其他 JavaScript 特有的設定
    };

    // 假設 activeTab.language 可以是 "python" 或 "javascript"
    const currentOptions = activeTab.language === "python" ? pythonOptions : jsOptions;

    return (
        <CodeMirrorEditor 
            activeTab={activeTab} 
            handleTabContentChange={handleTabContentChange} 
            handleCodeKeyDown={handleCodeKeyDown}
            options={currentOptions} // 將動態選項傳入
        />
    );
}
    */