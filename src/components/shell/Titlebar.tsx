import { useEffect, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'

interface TitlebarProps {
    title: string
    chrome?: 'mac' | 'win' | 'auto'
}

function detectChrome(): 'mac' | 'win' {
    if (typeof navigator === 'undefined') return 'win'
    const ua = navigator.userAgent || ''
    if (/Mac OS X|Macintosh/.test(ua)) return 'mac'
    return 'win'
}

const winApi = (op: 'min' | 'max' | 'close') => async () => {
    try {
        const w = getCurrentWindow()
        if (op === 'min') await w.minimize()
        else if (op === 'max') await w.toggleMaximize()
        else await w.close()
    } catch {
        /* preview / web — no-op */
    }
}

function MacTitlebar({ title }: { title: string }) {
    return (
        <div className="titlebar mac" data-tauri-drag-region>
            <div className="traffic" data-tauri-drag-region="false">
                <i onClick={winApi('close')} />
                <i onClick={winApi('min')} />
                <i onClick={winApi('max')} />
            </div>
            <div className="titlebar-title">{title}</div>
        </div>
    )
}

function WinTitlebar({ title }: { title: string }) {
    return (
        <div className="titlebar win" data-tauri-drag-region>
            <div className="titlebar-title">{title}</div>
            <div className="wincontrols" data-tauri-drag-region="false">
                <button onClick={winApi('min')} title="最小化">
                    <svg width="10" height="10" viewBox="0 0 10 10">
                        <path d="M0 5h10" stroke="currentColor" />
                    </svg>
                </button>
                <button onClick={winApi('max')} title="最大化">
                    <svg width="10" height="10" viewBox="0 0 10 10">
                        <path d="M0.5 0.5h9v9h-9z" fill="none" stroke="currentColor" />
                    </svg>
                </button>
                <button className="close" onClick={winApi('close')} title="关闭">
                    <svg width="10" height="10" viewBox="0 0 10 10">
                        <path d="M0 0l10 10M10 0l-10 10" stroke="currentColor" />
                    </svg>
                </button>
            </div>
        </div>
    )
}

export function Titlebar({ title, chrome = 'auto' }: TitlebarProps) {
    const [resolved, setResolved] = useState<'mac' | 'win'>(() =>
        chrome === 'auto' ? detectChrome() : chrome
    )
    useEffect(() => {
        if (chrome !== 'auto') setResolved(chrome)
    }, [chrome])

    return resolved === 'mac' ? <MacTitlebar title={title} /> : <WinTitlebar title={title} />
}
