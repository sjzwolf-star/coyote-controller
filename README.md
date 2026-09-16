# 郊狼 3.0 (Coyote V3) 蓝牙控制器

基于 DG-LAB 开源蓝牙协议开发的自定义控制应用，无需官方 App 即可直接通过蓝牙连接并控制设备。

## 在线演示

- **GitHub Pages**: https://sjzwolf-star.github.io/coyote-controller/
- 用 Android Chrome 打开即可连接设备

## 项目结构

```
coyote-controller/
├── web/                        # Web Bluetooth 控制器
│   ├── index.html              # 网页 UI (深色主题)
│   └── app.js                  # BLE 通信逻辑
├── python/                     # Python BLE 控制器
│   ├── coyote_controller.py    # bleak 实现 (可作 SDK)
│   ├── requirements.txt
│   └── pyproject.toml
├── docs/
│   └── protocol.md             # 完整蓝牙协议规格文档
├── .github/workflows/
│   └── deploy.yml              # GitHub Pages 自动部署
├── package.json
├── LICENSE
└── README.md
```

## 协议来源

- **官方开源协议**: [DG-LAB-OPENSOURCE](https://github.com/DG-LAB-OPENSOURCE/DG-LAB-OPENSOURCE)
- **英文翻译版**: [sdewis/dg-lab-opensource-english](https://github.com/sdewis/dg-lab-opensource-english)
- **协议摘要**: [dglab-deviant/coyote-3-studio](https://github.com/dglab-deviant/coyote-3-studio)

完整协议规格见 [docs/protocol.md](docs/protocol.md)。

## 快速开始

### Web 版 (推荐)

**在线使用 (手机/桌面):**
1. 用 Chrome 或 Edge 打开 https://sjzwolf-star.github.io/coyote-controller/
2. 确保郊狼 3.0 已开机（短按拨杆 0.5 秒，肩灯变黄）
3. 点击「连接设备」，选择 `47L121000`
4. 设置软上限（建议初始 50/50）
5. 选择波形和通道，点击「开始输出」

**本地开发:**
```bash
npm run dev
# 浏览器打开 http://localhost:8080
```

### Python 版 (桌面 SDK)

```bash
cd python
pip install -r requirements.txt
python coyote_controller.py
```

Python 版会自动扫描→连接→设置安全参数→输出「呼吸」波形→逐步增加强度→10 秒后停止。也可作为 SDK 集成到其他项目中：

```python
import asyncio
from coyote_controller import CoyoteController

async def main():
    ctrl = CoyoteController()
    await ctrl.connect()           # 扫描并连接
    ctrl.set_soft_cap(50, 50)      # 安全上限
    ctrl.set_waveform("breathing") # 选择波形
    ctrl.set_channel("A")          # 选择通道
    await ctrl.start_streaming()   # 开始输出
    await asyncio.sleep(5)
    await ctrl.emergency_stop()    # 紧急停止
    await ctrl.disconnect()

asyncio.run(main())
```

## 控制能力

| 功能 | 说明 |
|------|------|
| 通道强度控制 | A/B 双通道独立调节 (0~200)，支持相对增减和绝对设定 |
| 软上限设置 | BF 命令限制最大强度，设备关机后仍保存 |
| 波形输出 | 内置呼吸/潮汐/持续/脉冲，每 100ms 推送 B0 命令 |
| 实时强度反馈 | B1 通知同步实际强度（含物理滚轮变化） |
| 电池监控 | 实时读取电池电量 |
| 紧急停止 | 一键将强度归零 |
| 通道选择 | 仅 A / 仅 B / A+B 双通道 |
| 频率平衡参数 | 可调节高低频率的体感差异 |

## BLE 接口速查

| 项目 | 值 |
|------|------|
| 设备名称 | `47L121000` |
| 命令 Service | `0000180c-0000-1000-8000-00805f9b34fb` |
| 写入 Characteristic | `0000150a-0000-1000-8000-00805f9b34fb` |
| 通知 Characteristic | `0000150b-0000-1000-8000-00805f9b34fb` |
| 电池 Service | `0000180a-0000-1000-8000-00805f9b34fb` |

核心命令: **B0** (20 字节波形+强度) / **BF** (7 字节安全参数) / **B1** (4 字节强度回显通知)

## 平台兼容性

| 平台 | Web 版 | Python 版 |
|------|--------|-----------|
| Windows (Chrome/Edge) | 支持 | 支持 |
| macOS (Chrome/Edge) | 支持 | 支持 |
| Linux (Chrome/Edge) | 支持 | 支持 |
| Android (Chrome) | 支持 (需 HTTPS) | 不适用 |
| iOS (iPhone) | 不支持 | 不适用 |

> iOS 不支持 Web Bluetooth API。iPhone 用户需在电脑上运行 Python 版控制器。

## 安全提示

- 每次连接后应先设置较低的软上限（如 50/50）
- BF 命令立即生效且无返回值，重连后必须重新设置
- 停止发送 B0 后设备会自动停止输出（约 300ms 超时）
- 强度范围 0~200，超出范围的值会被视为 0
- 本工具仅供硬件开发与协议研究使用，请遵守设备安全规范

## License

MIT
