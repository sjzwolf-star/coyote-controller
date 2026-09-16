# 郊狼 3.0 (Coyote V3) 蓝牙控制器

基于 DG-LAB 开源蓝牙协议开发的 Coyote 3.0 自定义控制应用，无需官方 App 即可直接通过蓝牙连接并控制设备。

## 协议来源

- **官方开源协议**: [DG-LAB-OPENSOURCE](https://github.com/DG-LAB-OPENSOURCE/DG-LAB-OPENSOURCE)
- **英文翻译版**: [sdewis/dg-lab-opensource-english](https://github.com/sdewis/dg-lab-opensource-english)
- **协议摘要**: [dglab-deviant/coyote-3-studio](https://github.com/dglab-deviant/coyote-3-studio) — `Coyote V3 Protocol Summary.md`

## 蓝牙协议规格

| 项目 | 值 |
|------|------|
| 设备名称 | `47L121000` (Pulse Host 3.0) |
| 命令 Service UUID | `0000180c-0000-1000-8000-00805f9b34fb` |
| 写入 Characteristic UUID | `0000150a-0000-1000-8000-00805f9b34fb` |
| 通知 Characteristic UUID | `0000150b-0000-1000-8000-00805f9b34fb` |
| 电池 Service UUID | `0000180a-0000-1000-8000-00805f9b34fb` |
| 电池 Characteristic UUID | `00001500-0000-1000-8000-00805f9b34fb` |

### 命令格式

**B0 命令 (20 字节, 每 100ms 发送)** — 波形 + 强度推送

```
Byte 0:    0xB0 (命令头)
Byte 1:    [序列号:4bit | 强度解释:4bit]
Byte 2:    A 通道强度设定值 (0~200)
Byte 3:    B 通道强度设定值 (0~200)
Byte 4-7:  A 通道波形频率 × 4 (每个 10~240)
Byte 8-11: A 通道波形强度 × 4 (每个 0~100)
Byte 12-15: B 通道波形频率 × 4
Byte 16-19: B 通道波形强度 × 4
```

强度解释码 (Byte 1 低 4 位):
- `00` = 不改变, `01` = B相对增加, `10` = B相对减少, `11` = B绝对设定
- `00` = 不改变, `01` = A相对增加, `10` = A相对减少, `11` = A绝对设定
(高 2 位为 A, 低 2 位为 B)

**BF 命令 (7 字节)** — 软上限 + 平衡参数

```
Byte 0: 0xBF
Byte 1: A 软上限 (0~200)
Byte 2: B 软上限 (0~200)
Byte 3: A 频率平衡参数 (0~255)
Byte 4: B 频率平衡参数 (0~255)
Byte 5: A 强度平衡参数 (0~255)
Byte 6: B 强度平衡参数 (0~255)
```

**B1 通知 (4 字节)** — 强度回显

```
Byte 0: 0xB1
Byte 1: 序列号 (与 B0 的 seq 匹配)
Byte 2: A 通道当前实际强度
Byte 3: B 通道当前实际强度
```

### 频率压缩算法

用户友好值 (10~1000) → 蓝牙传输字节 (10~240):

```
10~100   → 原值
101~600  → (值 - 100) / 5 + 100
601~1000 → (值 - 600) / 10 + 200
```

## 文件说明

| 文件 | 说明 |
|------|------|
| `index.html` | Web Bluetooth 网页控制器 (Chrome/Edge) |
| `app.js` | Web 控制器逻辑 |
| `coyote_controller.py` | Python bleak 蓝牙控制器 |

## 使用方法

### Web 版 (推荐手机/桌面浏览器)

1. 使用 **Chrome** 或 **Edge** 浏览器打开 `index.html`
2. 确保设备已开机（短按拨杆 0.5 秒）
3. 点击「连接设备」，在弹窗中选择 `47L121000`
4. 连接成功后设置软上限（安全限制）
5. 选择波形和通道，点击「开始输出」

> 注意: Web Bluetooth 需要在 HTTPS 或 localhost 环境下运行。如需远程访问，可以使用 Python 内置服务器或 nginx 添加 HTTPS。

### Python 版 (桌面端)

```bash
pip install bleak
python coyote_controller.py
```

Python 版会自动扫描设备、连接、设置安全参数、输出「呼吸」波形 10 秒后自动停止。

## 控制权限

本控制器实现了以下控制能力:

- **通道强度控制**: A/B 双通道独立调节 (0~200), 支持相对增减和绝对设定
- **软上限设置**: 限制最大强度 (BF 命令), 设备关机后仍保存
- **波形输出**: 内置呼吸/潮汐/持续/脉冲波形, 每 100ms 推送 B0 命令
- **实时强度反馈**: 通过 B1 通知同步实际强度 (包括物理滚轮变化)
- **电池监控**: 实时读取电池电量
- **紧急停止**: 一键将强度归零
- **通道选择**: 可选仅 A、仅 B、或 A+B 双通道输出
- **频率平衡参数**: 可调节高低频率的体感差异

## 安全提示

- 每次连接后应先设置较低的软上限 (如 50/50)
- BF 命令立即生效且无返回值, 重连后必须重新设置
- 停止发送 B0 后设备会自动停止输出
- 强度范围 0~200, 超出范围的值会被视为 0
- 波形频率范围 10~240, 超出范围会导致该通道数据被丢弃
