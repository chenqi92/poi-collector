import * as React from 'react'
import {
    Info,
    CheckCircle2,
    AlertTriangle,
    XCircle,
    X,
} from 'lucide-react'

export type ToastVariant = 'info' | 'success' | 'warn' | 'error'

interface ToastItem {
    id: string
    title?: string
    description?: string
    variant?: ToastVariant
}

interface ToastContextValue {
    toasts: ToastItem[]
    addToast: (toast: Omit<ToastItem, 'id'>) => void
    removeToast: (id: string) => void
}

const ToastContext = React.createContext<ToastContextValue | null>(null)

const VARIANT_ICON: Record<ToastVariant, React.ComponentType<{ size?: number; className?: string }>> = {
    info: Info,
    success: CheckCircle2,
    warn: AlertTriangle,
    error: XCircle,
}

function Toast({
    id,
    title,
    description,
    variant = 'info',
    onClose,
}: ToastItem & { onClose: (id: string) => void }) {
    const Icon = VARIANT_ICON[variant]
    return (
        <div className={`toast ${variant}`}>
            <div className="toast-icon">
                <Icon size={15} />
            </div>
            <div className="toast-body">
                {title && <div className="toast-title">{title}</div>}
                {description && <div className="toast-sub">{description}</div>}
            </div>
            <button
                type="button"
                className="toast-x"
                onClick={() => onClose(id)}
                aria-label="关闭"
            >
                <X size={12} />
            </button>
        </div>
    )
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
    const [toasts, setToasts] = React.useState<ToastItem[]>([])

    const addToast = React.useCallback((toast: Omit<ToastItem, 'id'>) => {
        const id = Math.random().toString(36).slice(2, 9)
        setToasts(prev => [...prev, { ...toast, id }])
        setTimeout(() => {
            setToasts(prev => prev.filter(t => t.id !== id))
        }, 4000)
    }, [])

    const removeToast = React.useCallback((id: string) => {
        setToasts(prev => prev.filter(t => t.id !== id))
    }, [])

    return (
        <ToastContext.Provider value={{ toasts, addToast, removeToast }}>
            {children}
            <div className="toast-stack">
                {toasts.map(t => (
                    <Toast key={t.id} {...t} onClose={removeToast} />
                ))}
            </div>
        </ToastContext.Provider>
    )
}

export function useToast() {
    const context = React.useContext(ToastContext)
    if (!context) throw new Error('useToast must be used within ToastProvider')

    const { addToast } = context
    return {
        toast: addToast,
        info: (title: string, description?: string) =>
            addToast({ title, description, variant: 'info' }),
        success: (title: string, description?: string) =>
            addToast({ title, description, variant: 'success' }),
        warn: (title: string, description?: string) =>
            addToast({ title, description, variant: 'warn' }),
        // Back-compat: existing callers use `warning`
        warning: (title: string, description?: string) =>
            addToast({ title, description, variant: 'warn' }),
        error: (title: string, description?: string) =>
            addToast({ title, description, variant: 'error' }),
    }
}
