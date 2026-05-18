import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { GcIcon } from './Icon'

interface Point { x: number; y: number }
interface MenuItem {
    type?: 'item' | 'divider'
    label?: string
    icon?: string
    onClick?: () => void | Promise<void>
    disabled?: boolean
}

function isEditable(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement {
    if (!el) return false
    const tag = el.tagName
    if (tag === 'INPUT') {
        const type = (el as HTMLInputElement).type
        return type !== 'button' && type !== 'submit' && type !== 'checkbox' && type !== 'radio' && type !== 'file'
    }
    if (tag === 'TEXTAREA') return true
    if ((el as HTMLElement).isContentEditable) return true
    return false
}

function findEditableAncestor(el: Element | null): HTMLInputElement | HTMLTextAreaElement | null {
    let cur: Element | null = el
    while (cur) {
        if (isEditable(cur)) return cur as HTMLInputElement | HTMLTextAreaElement
        cur = cur.parentElement
    }
    return null
}

function findPathAttr(el: Element | null): string | null {
    let cur: Element | null = el
    while (cur) {
        const p = (cur as HTMLElement).dataset?.contextPath
        if (p) return p
        cur = cur.parentElement
    }
    return null
}

export function ContextMenuHost() {
    const [point, setPoint] = useState<Point | null>(null)
    const [items, setItems] = useState<MenuItem[]>([])
    const navigate = useNavigate()

    useEffect(() => {
        const handler = async (e: MouseEvent) => {
            const target = e.target as Element | null
            const editable = findEditableAncestor(target)
            const selection = window.getSelection()?.toString() ?? ''
            const hasSelection = selection.length > 0 || (
                editable !== null && (editable.selectionStart ?? 0) !== (editable.selectionEnd ?? 0)
            )
            const path = findPathAttr(target)

            const built: MenuItem[] = []

            // ── 文本编辑组 ────────────────────────────────
            if (editable || hasSelection) {
                built.push({
                    label: '复制',
                    icon: 'copy',
                    disabled: !hasSelection,
                    onClick: async () => {
                        let text = selection
                        if (!text && editable) {
                            const s = editable.selectionStart ?? 0
                            const t = editable.selectionEnd ?? 0
                            text = editable.value.slice(s, t)
                        }
                        if (text) await navigator.clipboard.writeText(text).catch(() => { })
                    },
                })
            }
            if (editable) {
                built.push({
                    label: '粘贴',
                    icon: 'download',
                    onClick: async () => {
                        try {
                            const text = await navigator.clipboard.readText()
                            const s = editable.selectionStart ?? editable.value.length
                            const t = editable.selectionEnd ?? editable.value.length
                            const next = editable.value.slice(0, s) + text + editable.value.slice(t)
                            // Use the native setter so React state listeners get notified.
                            const proto = editable instanceof HTMLTextAreaElement
                                ? HTMLTextAreaElement.prototype
                                : HTMLInputElement.prototype
                            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
                            setter?.call(editable, next)
                            editable.setSelectionRange(s + text.length, s + text.length)
                            editable.dispatchEvent(new Event('input', { bubbles: true }))
                        } catch { /* clipboard denied / empty */ }
                    },
                })
                built.push({
                    label: '全选',
                    onClick: () => { editable.select() },
                })
            }

            // ── 路径组 ───────────────────────────────────
            if (path) {
                if (built.length > 0) built.push({ type: 'divider' })
                built.push({
                    label: '复制路径',
                    icon: 'copy',
                    onClick: () => navigator.clipboard.writeText(path).catch(() => { }),
                })
                built.push({
                    label: '打开所在文件夹',
                    icon: 'folder',
                    onClick: () => revealItemInDir(path).catch(() => { }),
                })
            }

            // ── 路由导航 ─────────────────────────────────
            if (built.length > 0) built.push({ type: 'divider' })
            built.push({
                label: '返回',
                icon: 'chevronLeft',
                onClick: () => navigate(-1),
            })
            built.push({
                label: '前进',
                icon: 'chevronRight',
                onClick: () => navigate(1),
            })

            e.preventDefault()
            setItems(built)
            setPoint({ x: e.clientX, y: e.clientY })
        }
        document.addEventListener('contextmenu', handler)
        return () => document.removeEventListener('contextmenu', handler)
    }, [navigate])

    useEffect(() => {
        if (!point) return
        const close = (e: Event) => {
            if (e instanceof KeyboardEvent && e.key !== 'Escape') return
            setPoint(null)
        }
        const closeOnClick = () => setPoint(null)
        const t = setTimeout(() => {
            document.addEventListener('mousedown', closeOnClick)
            document.addEventListener('keydown', close)
        }, 0)
        return () => {
            clearTimeout(t)
            document.removeEventListener('mousedown', closeOnClick)
            document.removeEventListener('keydown', close)
        }
    }, [point])

    if (!point) return null

    // Clamp to viewport (8px margin).
    const MENU_W = 200
    const MENU_H = items.length * 28 + 8
    const left = Math.min(point.x, window.innerWidth - MENU_W - 8)
    const top = Math.min(point.y, window.innerHeight - MENU_H - 8)

    return createPortal(
        <div
            className="ctx-menu"
            style={{ left, top }}
            onContextMenu={e => e.preventDefault()}
        >
            {items.map((it, i) => it.type === 'divider' ? (
                <div className="ctx-divider" key={`d${i}`} />
            ) : (
                <button
                    key={i}
                    type="button"
                    className={`ctx-item${it.disabled ? ' disabled' : ''}`}
                    onClick={() => {
                        if (it.disabled) return
                        it.onClick?.()
                        setPoint(null)
                    }}
                    disabled={it.disabled}
                >
                    <span className="ctx-icon">
                        {it.icon && <GcIcon name={it.icon} size={12} />}
                    </span>
                    <span className="ctx-label">{it.label}</span>
                </button>
            ))}
        </div>,
        document.body
    )
}
