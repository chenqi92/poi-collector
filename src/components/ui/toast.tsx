import * as React from "react"
import { cn } from "@/lib/utils"
import { X } from "lucide-react"

interface ToastProps {
    id: string
    title?: string
    description?: string
    variant?: "default" | "success" | "error" | "warning"
    onClose: (id: string) => void
}

const variantStyles = {
    default: "bg-background border-border",
    success: "bg-green-50 border-green-200 dark:bg-green-900/20 dark:border-green-800",
    error: "bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-800",
    warning: "bg-yellow-50 border-yellow-200 dark:bg-yellow-900/20 dark:border-yellow-800",
}

const titleStyles = {
    default: "text-foreground",
    success: "text-green-800 dark:text-green-200",
    error: "text-red-800 dark:text-red-200",
    warning: "text-yellow-800 dark:text-yellow-200",
}

export function Toast({ id, title, description, variant = "default", onClose }: ToastProps) {
    return (
        <div
            className={cn(
                "flex items-start gap-3 p-4 rounded-lg border shadow-lg min-w-[300px] max-w-[400px] animate-in slide-in-from-right-full",
                variantStyles[variant]
            )}
        >
            <div className="flex-1">
                {title && (
                    <div className={cn("font-medium text-sm", titleStyles[variant])}>
                        {title}
                    </div>
                )}
                {description && (
                    <div className="text-sm text-muted-foreground mt-1">
                        {description}
                    </div>
                )}
            </div>
            <button
                onClick={() => onClose(id)}
                className="text-muted-foreground hover:text-foreground"
            >
                <X className="w-4 h-4" />
            </button>
        </div>
    )
}

interface ToastItem {
    id: string
    title?: string
    description?: string
    variant?: "default" | "success" | "error" | "warning"
}

interface ToastContextValue {
    toasts: ToastItem[]
    addToast: (toast: Omit<ToastItem, "id">) => void
    removeToast: (id: string) => void
}

const ToastContext = React.createContext<ToastContextValue | null>(null)

export function ToastProvider({ children }: { children: React.ReactNode }) {
    const [toasts, setToasts] = React.useState<ToastItem[]>([])

    const addToast = React.useCallback((toast: Omit<ToastItem, "id">) => {
        const id = Math.random().toString(36).substring(2, 9)
        setToasts(prev => [...prev, { ...toast, id }])

        // 自动移除
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
            {/* Toast Container */}
            <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
                {toasts.map(toast => (
                    <Toast
                        key={toast.id}
                        {...toast}
                        onClose={removeToast}
                    />
                ))}
            </div>
        </ToastContext.Provider>
    )
}

export function useToast() {
    const context = React.useContext(ToastContext)
    if (!context) {
        throw new Error("useToast must be used within ToastProvider")
    }

    return {
        toast: context.addToast,
        success: (title: string, description?: string) =>
            context.addToast({ title, description, variant: "success" }),
        error: (title: string, description?: string) =>
            context.addToast({ title, description, variant: "error" }),
        warning: (title: string, description?: string) =>
            context.addToast({ title, description, variant: "warning" }),
    }
}
