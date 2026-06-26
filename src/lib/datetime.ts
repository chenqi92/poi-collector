// 后端任务时间戳统一以 UTC 存储：
//  - SQLite CURRENT_TIMESTAMP  => "YYYY-MM-DD HH:MM:SS"（UTC，无时区标记）
//  - tile_downloader 写 chrono::Utc::now().to_rfc3339() => "...T..+00:00"（UTC，带偏移）
// 二者都是 UTC。前端按 UTC 解析后，渲染成本机所在时区的本地时间。

export function parseBackendTime(s: string | null | undefined): Date | null {
    if (!s) return null
    // 是否已带时区标记？（Z，或结尾的 +HH:MM / -HH:MM 偏移）
    const hasTz = s.includes('Z') || /[+-]\d\d:?\d\d$/.test(s.trim())
    const iso = s.trim().replace(' ', 'T') + (hasTz ? '' : 'Z')
    const d = new Date(iso)
    return isNaN(d.getTime()) ? null : d
}

const pad = (n: number) => String(n).padStart(2, '0')

/** 把后端 UTC 时间戳字符串渲染成本地 "YYYY-MM-DD HH:MM"（可带秒）。 */
export function formatBackendTime(
    s: string | null | undefined,
    opts?: { seconds?: boolean },
): string {
    const d = parseBackendTime(s)
    if (!d) return s ?? '—'
    const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    return opts?.seconds ? `${base}:${pad(d.getSeconds())}` : base
}
