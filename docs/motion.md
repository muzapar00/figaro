# 动效设计：按 Apple HIG 逐条落地

依据：[Human Interface Guidelines — Motion](https://developer.apple.com/cn/design/human-interface-guidelines/motion)
（2025-09 Liquid Glass 更新版）。下面每条先引原则，再写本项目的具体做法和实测。

## 1. "Add motion purposefully, supporting the experience without overshadowing it"

**做法**：每个状态只有**一个主旨动作**，装饰性的东西一律删掉。

| 状态 | 唯一主旨动作 | 删掉的东西 |
|---|---|---|
| 倾听 | 球随麦克风电平做弹性鼓胀（spring-damper）+ 电平环 | 声呐扩散环、旋转点阵 |
| 思考 | 球体内旋转的彗尾弧 | 外侧 8 个环绕点（曾经有）、形状蠕动 |
| 回答 | 音节起点向外扩散的脉冲环 | 独立波形组件 |

三种状态用颜色区分（蓝 / 紫 / 品红），形状不再承担区分职责。

## 2. "Make motion optional"

**做法**：读取桌面自身的动画设置（KDE `kdeglobals` 的 `AnimationDurationFactor`，
为 `0` 等同于系统的"减弱动态效果"）：

- 关闭形状波动、刻度环、脉冲环、彗尾旋转；唤醒应答不再弹一下。
- 几何变化仍然发生，但速度改为**临界阻尼**（`damping = 1.0`，不过冲）。
- 帧率降到 20 fps。
- 所有状态信息同时由**颜色 + 语音**承载，因此关掉动效不会丢信息。

实现：`qml/figaro/FigaroStyle.qml` 的 `reduceMotion` / `frameIntervalFor()`。

## 3. "Strive for realistic feedback motion that follows people's gestures"

**做法**：

- 电平包络是**弹簧-阻尼积分**（`k=260, c=14`，ζ≈0.43，约 25% 过冲），不是指数平滑：
  声音一响球会"弹"一下再回落。
- 球 → 胶囊的形变由**同一个 `morphProgress`** 驱动：胶囊宽高、圆角、球的缩放与位移、
  文字位置全是同一条曲线，所以看起来是一个物体被拉开，而不是胶囊凭空出现。
- 唤醒应答"我在"播出的同时球有一个 130ms 的 pop（见第 5 条）。

## 4. "Aim for brevity and precision in feedback animations"

**做法**：

- 文字是**被阅读**的内容，因此它的位移用 `OutCubic` 缓动、**不过冲**；只有用户不读的
  外壳（胶囊、球）才做弹性。
- 时长统一：进入/交叉淡入 180–220ms，退出 170ms，文字淡入 160ms，pop 130ms。
- 60 fps 只给"跟声音相关"的状态；思考是慢速旋转，20 fps 足够（见第 6 条）。

## 5. "Let people cancel motion"

**做法**：

- 任何时刻都能打断：点胶囊/球、短按 F9、说"取消/停下/别说了"；取消立刻停声、abort 请求。
- 打断后**快速收拢**（170ms 上收 + 淡出），不做回弹——回弹会被读成"它又回来了"。
- 唤醒应答是一次性的 pop（130ms），不是循环动画，不会让人等。

## 6. "In apps, generally avoid adding motion to UI interactions that occur frequently"

**做法**：

- 空闲时窗口不存在（`visible: false`），不渲染、0% CPU。
- 每次出现都是"新事件"：进场用弹簧、离场用快速缓出，没有常驻微动效。
- 帧率预算：倾听/回答 30 fps、思考 20 fps、关闭动态效果 20 fps。
  实测：可见时 CPU 从 72%（全屏宽窗口 + 60 fps）降到 ~54%，收窄窗口后进一步下降；
  隐藏时 0%。

## 7. Liquid Glass（KOS / KWin）

依据 HIG 2025 关于 Liquid Glass 的更新：材质应当"响应内容与输入"，并且由系统负责。

**做法**：胶囊通过 KOS 的 `Kos.SurfaceShape` 插件向 KWin 声明形状
（`effectType: SurfaceShape.Liquid`），由 **KWin** 画模糊、折射、边缘高光和噪点，
客户端不画材质；再叠一层 KOS 同款的固定深色 tint 保证白字可读。
好处有两个：这是桌面里其他玻璃面板（Dock/Bar）用的同一套材质，观感一致；并且
效果在合成器侧完成，overlay 依旧跑软件渲染、不依赖 GPU 上下文。

## 已知取舍

- 软件渲染下 Canvas 每帧重绘，可见时约占单核 30–55%；隐藏时 0%。对"每次交互几秒"
  的浮层可以接受，但如果要常驻显示，应该换回 GPU 渲染或把球预渲染成图片。
- 思考态的彗尾弧是持续旋转（0.2 Hz 以下的持续摆动是 HIG 明确不推荐的频段；
  当前周期约 2.4 s ≈ 0.4 Hz，且在球体内、对比度低，未采用更低频率）。
