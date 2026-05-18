import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { GcIcon } from './Icon'

interface Step {
    icon: string
    label: string
    title: string
    body: string
    targetRoute?: string
    cta?: string
}

const STEPS: Step[] = [
    {
        icon: 'sparkle',
        label: '欢迎',
        title: '欢迎使用 GeoCollector',
        body: 'GeoCollector 是一个桌面端地理数据采集工具：在本机采集 POI / 航标，下载离线瓦片，按需导出。整个过程不到 2 分钟即可完成第一次配置。',
    },
    {
        icon: 'key',
        label: '第一步',
        title: '配置 API Key',
        body: '在「设置 → API Keys」录入至少一个平台的 Key。天地图 / 高德 / 百度 提供免费配额；OpenStreetMap 无需 Key 即可使用。',
        targetRoute: '/settings?tab=keys',
        cta: '去配置 Key',
    },
    {
        icon: 'mapPin',
        label: '第二步',
        title: '选择地区',
        body: '到「新建采集」选择 POI 或瓦片，在地图上画框、或在地区树中勾选省/市/区。可选多个地区一次采集。',
        targetRoute: '/new',
        cta: '新建采集任务',
    },
    {
        icon: 'play',
        label: '第三步',
        title: '启动并查看进度',
        body: '点击「立即开始」启动任务，顶栏的任务托盘 + 底部状态栏会实时显示进度。任务完成后到「数据中心」查看与导出。',
        targetRoute: '/workspace',
        cta: '前往工作台',
    },
]

const ONBOARDING_KEY = 'poi-onboarding-done'

interface OnboardingProps {
    open: boolean
    onClose: () => void
}

export function Onboarding({ open, onClose }: OnboardingProps) {
    const navigate = useNavigate()
    const [step, setStep] = useState(0)

    useEffect(() => {
        if (open) setStep(0)
    }, [open])

    useEffect(() => {
        if (!open) return
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault()
                finish()
            } else if (e.key === 'ArrowRight') {
                e.preventDefault()
                next()
            } else if (e.key === 'ArrowLeft') {
                e.preventDefault()
                prev()
            }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, step])

    if (!open) return null

    const finish = () => {
        localStorage.setItem(ONBOARDING_KEY, '1')
        onClose()
    }

    const next = () => {
        if (step >= STEPS.length - 1) finish()
        else setStep(s => s + 1)
    }

    const prev = () => setStep(s => Math.max(0, s - 1))

    const cur = STEPS[step]
    const isLast = step === STEPS.length - 1
    const isFirst = step === 0

    const goTarget = () => {
        if (cur.targetRoute) navigate(cur.targetRoute)
        if (isLast) finish()
        else next()
    }

    return (
        <div className="onb-overlay">
            <div className="onb-mask" />
            <div
                className="onb-card"
                style={{
                    left: '50%',
                    top: '50%',
                    transform: 'translate(-50%, -50%)',
                }}
            >
                <div className="onb-card-head">
                    <div className="onb-icon"><GcIcon name={cur.icon} size={16} /></div>
                    <div className="onb-step-no">
                        {cur.label}
                        <span style={{ color: 'var(--text-4)', fontWeight: 500, marginLeft: 4 }}>
                            ({step + 1}/{STEPS.length})
                        </span>
                    </div>
                </div>
                <h3 className="onb-title">{cur.title}</h3>
                <p className="onb-body">{cur.body}</p>

                <div className="onb-dots">
                    {STEPS.map((_, i) => (
                        <span
                            key={i}
                            className={`onb-dot${i === step ? ' active' : ''}`}
                            onClick={() => setStep(i)}
                        />
                    ))}
                </div>

                <div className="onb-actions">
                    <button
                        type="button"
                        className="btn ghost sm"
                        onClick={finish}
                    >
                        跳过引导
                    </button>
                    <span style={{ flex: 1 }} />
                    {!isFirst && (
                        <button type="button" className="btn sm" onClick={prev}>
                            <GcIcon name="chevronLeft" size={11} />上一步
                        </button>
                    )}
                    {cur.cta ? (
                        <button type="button" className="btn primary sm" onClick={goTarget}>
                            {cur.cta}
                            <GcIcon name="chevronRight" size={11} />
                        </button>
                    ) : (
                        <button type="button" className="btn primary sm" onClick={next}>
                            {isLast ? '完成' : '下一步'}
                            {!isLast && <GcIcon name="chevronRight" size={11} />}
                        </button>
                    )}
                </div>
            </div>
        </div>
    )
}

/** Returns true if the user has not yet completed onboarding on this device. */
export function shouldShowOnboarding(): boolean {
    return localStorage.getItem(ONBOARDING_KEY) !== '1'
}
