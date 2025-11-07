// 1. 將圖示定義抽離到一個獨立的物件中
const ICON_PATHS = {
    play: <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.348a1.125 1.125 0 010 1.971l-11.54 6.347a1.125 1.125 0 01-1.667-.985V5.653z" />,
    code: <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />,
    book: <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />,
    send: <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />,
    chevron: <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />,
    menu: <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />,
    edit: <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />,
};

// 2. 優化後的 Icon 元件
const Icon = ({ name, className, isExpanded }) => {
    const iconPath = ICON_PATHS[name];
    
    // 處理找不到圖示的情況
    if (!iconPath) {
        console.warn(`Icon "${name}" not found in ICON_PATHS.`);
        return null; // 或者返回一個預設的佔位圖示
    }

    const rotation = name === 'chevron' ? (isExpanded ? 'rotate-180' : 'rotate-0') : '';
    
    return (
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className={`${className} transition-transform duration-200 ${rotation}`}>
            {iconPath}
        </svg>
    );
};

// 3. 範例：如何在父元件中使用
/*
function Header() {
    const [isMenuOpen, setIsMenuOpen] = React.useState(false);

    return (
        <div className="flex justify-between p-4">
            <button onClick={() => setIsMenuOpen(!isMenuOpen)}>
                <Icon name="menu" className="w-6 h-6" />
            </button>
            <div className="flex space-x-2">
                <Icon name="play" className="w-6 h-6 text-green-500" />
                <Icon name="code" className="w-6 h-6 text-blue-500" />
                <Icon name="book" className="w-6 h-6 text-yellow-500" />
            </div>
        </div>
    );
}
*/