"""
DG-LAB Coyote 3.0 BLE Controller (Python / bleak)
协议来源: DG-LAB Open Source (github.com/DG-LAB-OPENSOURCE)

依赖安装: pip install bleak

用法:
    python coyote_controller.py
"""

import asyncio
import struct
import logging
from dataclasses import dataclass, field
from typing import Optional, Callable

try:
    from bleak import BleakClient, BleakScanner
    from bleak.backends.characteristic import BleakGATTCharacteristic
except ImportError:
    print("请先安装 bleak: pip install bleak")
    raise SystemExit(1)

# ─── BLE UUIDs ──────────────────────────────────────────────
SERVICE_COMMAND = "0000180c-0000-1000-8000-00805f9b34fb"
SERVICE_BATTERY  = "0000180a-0000-1000-8000-00805f9b34fb"
CHAR_WRITE       = "0000150a-0000-1000-8000-00805f9b34fb"
CHAR_NOTIFY      = "0000150b-0000-1000-8000-00805f9b34fb"
CHAR_BATTERY     = "00001500-0000-1000-8000-00805f9b34fb"
DEVICE_NAME      = "47L121000"

# ─── Protocol Constants ─────────────────────────────────────
CMD_B0 = 0xB0
CMD_BF = 0xBF
MSG_B1 = 0xB1

# ─── Waveform Definitions ───────────────────────────────────
WAVEFORMS = {
    "breathing": [
        {"freq": 10, "intensity": 0},   {"freq": 10, "intensity": 20},
        {"freq": 10, "intensity": 40},  {"freq": 10, "intensity": 60},
        {"freq": 10, "intensity": 80},  {"freq": 10, "intensity": 100},
        {"freq": 10, "intensity": 100}, {"freq": 10, "intensity": 100},
        {"freq": 10, "intensity": 0},   {"freq": 10, "intensity": 0},
        {"freq": 10, "intensity": 0},   {"freq": 10, "intensity": 0},
    ],
    "tide": [
        {"freq": 10, "intensity": 0},   {"freq": 11, "intensity": 16},
        {"freq": 13, "intensity": 33},  {"freq": 14, "intensity": 50},
        {"freq": 16, "intensity": 66},  {"freq": 18, "intensity": 83},
        {"freq": 19, "intensity": 100}, {"freq": 21, "intensity": 92},
        {"freq": 22, "intensity": 84},  {"freq": 24, "intensity": 76},
        {"freq": 26, "intensity": 68},  {"freq": 26, "intensity": 0},
        {"freq": 27, "intensity": 16},  {"freq": 29, "intensity": 33},
        {"freq": 30, "intensity": 50},  {"freq": 32, "intensity": 66},
        {"freq": 34, "intensity": 83},  {"freq": 35, "intensity": 100},
        {"freq": 37, "intensity": 92},  {"freq": 38, "intensity": 84},
        {"freq": 40, "intensity": 76},  {"freq": 42, "intensity": 68},
        {"freq": 10, "intensity": 0},
    ],
    "steady": [
        {"freq": 10, "intensity": 50},
        {"freq": 10, "intensity": 50},
        {"freq": 10, "intensity": 50},
        {"freq": 10, "intensity": 50},
    ],
    "pulse": [
        {"freq": 10, "intensity": 100},
        {"freq": 10, "intensity": 0},
        {"freq": 10, "intensity": 100},
        {"freq": 10, "intensity": 0},
    ],
    "off": [
        {"freq": 10, "intensity": 0},
        {"freq": 10, "intensity": 0},
        {"freq": 10, "intensity": 0},
        {"freq": 10, "intensity": 0},
    ],
}


def compress_frequency(input_val: int) -> int:
    """将用户友好的频率值 (10..1000) 压缩为蓝牙传输字节 (10..240)"""
    if 10 <= input_val <= 100:
        return input_val
    elif 101 <= input_val <= 600:
        return (input_val - 100) // 5 + 100
    elif 601 <= input_val <= 1000:
        return (input_val - 600) // 10 + 200
    return 10


def clamp(val, lo, hi):
    return max(lo, min(hi, val))


@dataclass
class CoyoteState:
    connected: bool = False
    intensity_a: int = 0
    intensity_b: int = 0
    soft_cap_a: int = 50
    soft_cap_b: int = 50
    balance_freq_a: int = 160
    balance_freq_b: int = 160
    balance_int_a: int = 100
    balance_int_b: int = 100
    battery_level: int = 0
    streaming: bool = False
    seq_counter: int = 0
    pending_seq: int = 0
    input_allowed_a: bool = True
    input_allowed_b: bool = True
    accum_a: int = 0
    accum_b: int = 0
    waveform_name: str = "breathing"
    waveform_channel: str = "A"
    waveform_index: int = 0


class CoyoteController:
    def __init__(self):
        self.state = CoyoteState()
        self.client: Optional[BleakClient] = None
        self.stream_task: Optional[asyncio.Task] = None
        self.logger = logging.getLogger("coyote")
        logging.basicConfig(level=logging.INFO, format="[%(asctime)s] %(message)s",
                            datefmt="%H:%M:%S")

    async def scan(self, timeout=10.0):
        """扫描 Coyote 3.0 设备"""
        self.logger.info(f"正在扫描设备 ({DEVICE_NAME})...")
        devices = await BleakScanner.discover(timeout=timeout)
        for d in devices:
            if d.name and DEVICE_NAME in d.name:
                self.logger.info(f"找到设备: {d.name} ({d.address})")
                return d
        self.logger.warning("未找到郊狼 3.0 设备")
        return None

    async def connect(self, address: Optional[str] = None):
        """连接设备"""
        if address is None:
            device = await self.scan()
            if device is None:
                return False
            address = device.address

        self.logger.info(f"正在连接 {address}...")
        self.client = BleakClient(address)
        await self.client.connect()
        self.state.connected = self.client.is_connected

        if not self.state.connected:
            self.logger.error("连接失败")
            return False

        self.logger.info("连接成功！")

        # Subscribe to notify
        await self.client.start_notify(CHAR_NOTIFY, self._on_notify)
        self.logger.info("已订阅 0x150B 通知")

        # Read battery
        try:
            bat_data = await self.client.read_gatt_char(CHAR_BATTERY)
            self.state.battery_level = bat_data[0]
            self.logger.info(f"电池电量: {self.state.battery_level}%")
            await self.client.start_notify(CHAR_BATTERY, self._on_battery_notify)
        except Exception as e:
            self.logger.warning(f"电池服务不可用: {e}")

        # Set soft cap immediately
        await self.send_bf()
        self.logger.info(f"安全参数已设置 (软上限 A/B = {self.state.soft_cap_a}/{self.state.soft_cap_b})")
        return True

    async def disconnect(self):
        """断开连接"""
        await self.stop_streaming()
        if self.client and self.client.is_connected:
            await self.client.disconnect()
        self.state.connected = False
        self.logger.info("设备已断开")

    async def _on_notify(self, char: BleakGATTCharacteristic, data: bytearray):
        """处理设备通知"""
        if len(data) < 1:
            return
        cmd = data[0]
        if cmd == MSG_B1 and len(data) >= 4:
            seq = data[1]
            self.state.intensity_a = data[2]
            self.state.intensity_b = data[3]
            if seq > 0 and seq == self.state.pending_seq:
                self.state.pending_seq = 0
                self.state.input_allowed_a = True
                self.state.input_allowed_b = True

    async def _on_battery_notify(self, char: BleakGATTCharacteristic, data: bytearray):
        if len(data) >= 1:
            self.state.battery_level = data[0]

    async def _write(self, payload: bytes):
        if not self.client or not self.client.is_connected:
            return
        try:
            await self.client.write_gatt_char(CHAR_WRITE, payload, response=False)
        except Exception as e:
            self.logger.error(f"写入失败: {e}")

    async def send_bf(self):
        """发送 BF 命令: 软上限 + 平衡参数"""
        payload = struct.pack(
            "<BBBBBBB",
            CMD_BF,
            clamp(self.state.soft_cap_a, 0, 200),
            clamp(self.state.soft_cap_b, 0, 200),
            clamp(self.state.balance_freq_a, 0, 255),
            clamp(self.state.balance_freq_b, 0, 255),
            clamp(self.state.balance_int_a, 0, 255),
            clamp(self.state.balance_int_b, 0, 255),
        )
        await self._write(payload)

    async def send_b0(self):
        """发送 B0 命令: 波形 + 强度 (20 字节, 每 100ms)"""
        wf = WAVEFORMS.get(self.state.waveform_name, WAVEFORMS["off"])
        slices = wf

        idx = self.state.waveform_index
        s0 = slices[idx % len(slices)]
        s1 = slices[(idx + 1) % len(slices)]
        s2 = slices[(idx + 2) % len(slices)]
        s3 = slices[(idx + 3) % len(slices)]
        self.state.waveform_index = (idx + 4) % len(slices)

        freqs = [
            compress_frequency(s0["freq"]),
            compress_frequency(s1["freq"]),
            compress_frequency(s2["freq"]),
            compress_frequency(s3["freq"]),
        ]
        ints = [
            clamp(s0["intensity"], 0, 100),
            clamp(s1["intensity"], 0, 100),
            clamp(s2["intensity"], 0, 100),
            clamp(s3["intensity"], 0, 100),
        ]

        # Build interp + setpoint
        interp = 0
        setpoint_a = 0
        setpoint_b = 0
        seq = 0

        if self.state.input_allowed_a and self.state.accum_a != 0:
            if self.state.accum_a > 0:
                interp |= 0x40  # A relative add
            else:
                interp |= 0x80  # A relative sub
            setpoint_a = abs(self.state.accum_a)
            self.state.seq_counter = (self.state.seq_counter + 1) & 0x0F
            if self.state.seq_counter == 0:
                self.state.seq_counter = 1
            seq = self.state.seq_counter
            self.state.pending_seq = seq
            self.state.input_allowed_a = False
            self.state.accum_a = 0

        if self.state.input_allowed_b and self.state.accum_b != 0:
            if self.state.accum_b > 0:
                interp |= 0x01  # B relative add
            else:
                interp |= 0x02  # B relative sub
            setpoint_b = abs(self.state.accum_b)
            if seq == 0:
                self.state.seq_counter = (self.state.seq_counter + 1) & 0x0F
                if self.state.seq_counter == 0:
                    self.state.seq_counter = 1
                seq = self.state.seq_counter
            self.state.pending_seq = seq
            self.state.input_allowed_b = False
            self.state.accum_b = 0

        payload = bytearray(20)
        payload[0] = CMD_B0
        payload[1] = ((seq & 0x0F) << 4) | (interp & 0x0F)
        payload[2] = clamp(setpoint_a, 0, 200)
        payload[3] = clamp(setpoint_b, 0, 200)

        ch = self.state.waveform_channel
        if ch in ("A", "AB"):
            payload[4:8] = bytes(freqs)
            payload[8:12] = bytes(ints)
        else:
            payload[4:8] = bytes([10, 10, 10, 10])
            payload[8:12] = bytes([0, 0, 0, 101])

        if ch in ("B", "AB"):
            payload[12:16] = bytes(freqs)
            payload[16:20] = bytes(ints)
        else:
            payload[12:16] = bytes([10, 10, 10, 10])
            payload[16:20] = bytes([0, 0, 0, 101])

        await self._write(bytes(payload))

    async def start_streaming(self):
        """开始波形输出 (每 100ms 发送 B0)"""
        if not self.state.connected:
            self.logger.warning("请先连接设备")
            return
        if self.state.streaming:
            return
        self.state.streaming = True
        self.state.waveform_index = 0
        wf_name = self.state.waveform_name
        self.logger.info(f"开始输出波形: {wf_name}")

        async def stream_loop():
            while self.state.streaming and self.state.connected:
                await self.send_b0()
                await asyncio.sleep(0.1)  # 100ms

        self.stream_task = asyncio.create_task(stream_loop())

    async def stop_streaming(self):
        """停止波形输出"""
        if not self.state.streaming:
            return
        self.state.streaming = False
        if self.stream_task:
            self.stream_task.cancel()
            try:
                await self.stream_task
            except asyncio.CancelledError:
                pass
            self.stream_task = None

        # Send a final zero-output B0
        if self.client and self.client.is_connected:
            payload = bytes(20)  # all zeros = no output
            payload = bytearray(payload)
            payload[0] = CMD_B0
            await self._write(bytes(payload))

        self.logger.info("已停止波形输出")

    def change_intensity_a(self, delta: int):
        self.state.accum_a += delta
        sign = "+" if delta > 0 else ""
        self.logger.info(f"A通道强度变化: {sign}{delta}")

    def change_intensity_b(self, delta: int):
        self.state.accum_b += delta
        sign = "+" if delta > 0 else ""
        self.logger.info(f"B通道强度变化: {sign}{delta}")

    async def set_intensity_absolute(self, channel: str, value: int):
        """设置通道绝对强度"""
        value = clamp(value, 0, 200)
        self.state.seq_counter = (self.state.seq_counter + 1) & 0x0F
        if self.state.seq_counter == 0:
            self.state.seq_counter = 1
        self.state.pending_seq = self.state.seq_counter

        if channel == "A":
            self.state.input_allowed_a = False
            interp = 0xC0  # A absolute
            payload_bytes = struct.pack("<BBBB", CMD_B0,
                                        ((self.state.pending_seq & 0x0F) << 4) | (interp & 0x0F),
                                        value, 0)
        else:
            self.state.input_allowed_b = False
            interp = 0x03  # B absolute
            payload_bytes = struct.pack("<BBBB", CMD_B0,
                                        ((self.state.pending_seq & 0x0F) << 4) | (interp & 0x0F),
                                        0, value)

        # Append waveform data
        wf = WAVEFORMS.get(self.state.waveform_name, WAVEFORMS["off"])
        idx = self.state.waveform_index
        slices = [
            wf[idx % len(wf)], wf[(idx+1) % len(wf)],
            wf[(idx+2) % len(wf)], wf[(idx+3) % len(wf)]
        ]
        freqs = [compress_frequency(s["freq"]) for s in slices]
        ints = [clamp(s["intensity"], 0, 100) for s in slices]

        ch = self.state.waveform_channel
        payload = bytearray(payload_bytes) + bytearray(16)
        if ch in ("A", "AB"):
            payload[4:8] = bytes(freqs)
            payload[8:12] = bytes(ints)
        else:
            payload[4:8] = bytes([10,10,10,10])
            payload[8:12] = bytes([0,0,0,101])
        if ch in ("B", "AB"):
            payload[12:16] = bytes(freqs)
            payload[16:20] = bytes(ints)
        else:
            payload[12:16] = bytes([10,10,10,10])
            payload[16:20] = bytes([0,0,0,101])

        await self._write(bytes(payload))
        self.logger.info(f"设置 {channel} 通道强度 = {value}")

    async def emergency_stop(self):
        """紧急停止: 强度归零"""
        self.state.seq_counter = (self.state.seq_counter + 1) & 0x0F
        if self.state.seq_counter == 0:
            self.state.seq_counter = 1
        self.state.pending_seq = self.state.seq_counter
        self.state.input_allowed_a = False
        self.state.input_allowed_b = False

        interp = 0xCC  # both absolute
        payload = bytearray(20)
        payload[0] = CMD_B0
        payload[1] = ((self.state.pending_seq & 0x0F) << 4) | (interp & 0x0F)
        payload[2] = 0  # A = 0
        payload[3] = 0  # B = 0
        # all-zero waveform
        await self._write(bytes(payload))
        self.state.intensity_a = 0
        self.state.intensity_b = 0
        self.logger.warning("紧急停止：强度归零！")

    def set_soft_cap(self, a: int, b: int):
        self.state.soft_cap_a = clamp(a, 0, 200)
        self.state.soft_cap_b = clamp(b, 0, 200)

    def set_waveform(self, name: str):
        if name in WAVEFORMS:
            self.state.waveform_name = name
            self.state.waveform_index = 0
            self.logger.info(f"已选择波形: {name}")

    def set_channel(self, channel: str):
        if channel in ("A", "B", "AB"):
            self.state.waveform_channel = channel
            self.logger.info(f"输出通道: {channel}")


async def interactive_demo():
    """交互式演示"""
    controller = CoyoteController()

    print("=" * 50)
    print("  郊狼 3.0 (Coyote V3) 蓝牙控制器 - Python 版")
    print("  协议来源: DG-LAB Open Source")
    print("=" * 50)
    print()

    # Connect
    connected = await controller.connect()
    if not connected:
        print("连接失败，退出。")
        return

    print("\n已连接！当前安全配置:")
    print(f"  软上限: A={controller.state.soft_cap_a}, B={controller.state.soft_cap_b}")
    print(f"  电池: {controller.state.battery_level}%")
    print()

    # Start breathing waveform on A channel
    controller.set_waveform("breathing")
    controller.set_channel("A")
    await controller.start_streaming()

    print("已开始输出「呼吸」波形到 A 通道")
    print("10 秒后自动停止...\n")

    await asyncio.sleep(3)
    # Gradually increase intensity
    print("逐步增加 A 通道强度...")
    for i in range(5):
        controller.change_intensity_a(2)
        await asyncio.sleep(1)
        print(f"  A 通道实际强度: {controller.state.intensity_a}")

    await asyncio.sleep(3)

    # Stop
    await controller.stop_streaming()
    print("\n波形输出已停止")

    # Emergency stop
    await controller.emergency_stop()
    print("强度已归零")

    # Disconnect
    await controller.disconnect()
    print("\n演示完成，已断开设备。")


if __name__ == "__main__":
    asyncio.run(interactive_demo())
