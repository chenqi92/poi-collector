import { createContext, useContext, useEffect, useState } from "react"

type Theme = "dark" | "light" | "system"
type Density = "compact" | "standard" | "comfy"
type Accent = "blue" | "green" | "purple" | "orange"

type ThemeProviderProps = {
    children: React.ReactNode
    defaultTheme?: Theme
    storageKey?: string
}

type ThemeProviderState = {
    theme: Theme
    resolvedTheme: "light" | "dark"
    setTheme: (theme: Theme) => void
    toggleTheme: () => void
    density: Density
    setDensity: (d: Density) => void
    accent: Accent
    setAccent: (a: Accent) => void
}

const initialState: ThemeProviderState = {
    theme: "system",
    resolvedTheme: "dark",
    setTheme: () => null,
    toggleTheme: () => null,
    density: "standard",
    setDensity: () => null,
    accent: "blue",
    setAccent: () => null,
}

const ThemeProviderContext = createContext<ThemeProviderState>(initialState)

const ACCENT_MAP: Record<Accent, { h: number; c: number }> = {
    blue:   { h: 224, c: 0.18 },
    green:  { h: 150, c: 0.14 },
    purple: { h: 290, c: 0.18 },
    orange: { h: 40,  c: 0.18 },
}

export function ThemeProvider({
    children,
    defaultTheme = "dark",
    storageKey = "poi-ui-theme",
    ...props
}: ThemeProviderProps) {
    const [theme, setThemeState] = useState<Theme>(
        () => (localStorage.getItem(storageKey) as Theme) || defaultTheme
    )
    const [density, setDensityState] = useState<Density>(
        () => (localStorage.getItem("poi-ui-density") as Density) || "standard"
    )
    const [accent, setAccentState] = useState<Accent>(
        () => (localStorage.getItem("poi-ui-accent") as Accent) || "blue"
    )
    const [resolved, setResolved] = useState<"light" | "dark">("dark")

    useEffect(() => {
        const root = window.document.documentElement
        const apply = (mode: "light" | "dark") => {
            root.classList.remove("light", "dark")
            root.classList.add(mode)
            root.setAttribute("data-theme", mode)
            setResolved(mode)
        }
        if (theme === "system") {
            const mq = window.matchMedia("(prefers-color-scheme: dark)")
            apply(mq.matches ? "dark" : "light")
            const handler = (e: MediaQueryListEvent) => apply(e.matches ? "dark" : "light")
            mq.addEventListener("change", handler)
            return () => mq.removeEventListener("change", handler)
        }
        apply(theme)
    }, [theme])

    useEffect(() => {
        document.documentElement.setAttribute("data-density", density)
    }, [density])

    useEffect(() => {
        const root = document.documentElement
        const a = ACCENT_MAP[accent] || ACCENT_MAP.blue
        root.style.setProperty("--accent-h", String(a.h))
        root.style.setProperty("--accent-c", String(a.c))
        root.setAttribute("data-accent", accent)
    }, [accent])

    useEffect(() => {
        // Frameless flag for the design CSS (rounded corners on .win).
        // We're going fully custom-chrome, so always 1.
        document.documentElement.setAttribute("data-frameless", "1")
    }, [])

    const value: ThemeProviderState = {
        theme,
        resolvedTheme: resolved,
        setTheme: (t: Theme) => {
            localStorage.setItem(storageKey, t)
            setThemeState(t)
        },
        toggleTheme: () => {
            const next = resolved === "dark" ? "light" : "dark"
            localStorage.setItem(storageKey, next)
            setThemeState(next)
        },
        density,
        setDensity: (d: Density) => {
            localStorage.setItem("poi-ui-density", d)
            setDensityState(d)
        },
        accent,
        setAccent: (a: Accent) => {
            localStorage.setItem("poi-ui-accent", a)
            setAccentState(a)
        },
    }

    return (
        <ThemeProviderContext.Provider {...props} value={value}>
            {children}
        </ThemeProviderContext.Provider>
    )
}

export const useTheme = () => {
    const context = useContext(ThemeProviderContext)
    if (context === undefined)
        throw new Error("useTheme must be used within a ThemeProvider")
    return context
}
