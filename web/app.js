/**
 * DG-LAB Coyote 3.0 BLE Controller
 * 
 * Protocol source: DG-LAB Open Source (https://github.com/DG-LAB-OPENSOURCE)
 * English translation: https://github.com/sdewis/dg-lab-opensource-english
 * Protocol summary: https://github.com/dglab-deviant/coyote-3-studio
 *
 * BLE Surface:
 *   Device name: 47L121000 (Pulse Host 3.0)
 *   Service 0x180C -> 0x150A (Write)  : all commands go here
 *   Service 0x180C -> 0x150B (Notify) : all responses arrive here
 *   Service 0x180A -> 0x1500 (Read/Notify) : battery level
 *   Base UUID: 0000xxxx-0000-1000-8000-00805f9b34fb
 */

// ─── BLE UUIDs ──────────────────────────────────────────────
const SERVICE_COMMAND = "0000180c-0000-1000-8000-00805f9b34fb";
const SERVICE_BATTERY  = "0000180a-0000-1000-8000-00805f9b34fb";
const CHAR_WRITE       = "0000150a-0000-1000-8000-00805f9b34fb";
const CHAR_NOTIFY      = "0000150b-0000-1000-8000-00805f9b34fb";
const CHAR_BATTERY     = "00001500-0000-1000-8000-00805f9b34fb";
const DEVICE_NAME      = "47L121000";

// ─── Protocol Constants ─────────────────────────────────────
const CMD_B0 = 0xb0;  // waveform + intensity push (20 bytes, every 100ms)
const CMD_BF = 0xbf;  // soft cap + balance params (7 bytes)
const MSG_B1 = 0xb1;  // intensity echo (4 bytes, notify)

// Intensity interpretation codes (low nibble of byte 1)
const INTERP_NONE      = 0b0000;
const INTERP_A_REL_ADD = 0b0100;
const INTERP_A_REL_SUB = 0b1000;
const INTERP_A_ABS     = 0b1100;
const INTERP_B_REL_ADD = 0b0001;
const INTERP_B_REL_SUB = 0b0010;
const INTERP_B_ABS     = 0b0011;

// Valid ranges
const INTENSITY_MIN = 0;
const INTENSITY_MAX = 200;
const FREQ_BYTE_MIN = 10;
const FREQ_BYTE_MAX = 240;
const WAVE_INTENSITY_MIN = 0;
const WAVE_INTENSITY_MAX = 100;

// ─── State ──────────────────────────────────────────────────
const state = {
    connected: false,
    device: null,
    server: null,
    writeChar: null,
    notifyChar: null,
    batteryChar: null,
    batteryLevel: 0,

    // intensity tracking
    intensityA: 0,
    intensityB: 0,
    softCapA: 50,         // safe default
    softCapB: 50,         // safe default
    balanceFreqA: 160,
    balanceFreqB: 160,
    balanceIntA: 100,
    balanceIntB: 100,

    // B0 streaming
    streaming: false,
    streamTimer: null,
    seqCounter: 0,
    pendingSeq: 0,
    inputAllowedA: true,
    inputAllowedB: true,
    accumA: 0,
    accumB: 0,

    // current waveform
    waveformName: "breathing",
    waveformChannel: "A",   // "A", "B", or "AB"
    waveformIndex: 0,

    // log
    logEntries: [],
};

// ─── Waveform Definitions ───────────────────────────────────
// Each waveform is a list of {freq, intensity} slices (25ms each, 4 per B0)
// freq is the user-friendly value (10..1000), will be compressed to 10..240
const WAVEFORMS = {
    breathing: {
        name: "呼吸",
        slices: [
            { freq: 10, intensity: 0   },
            { freq: 10, intensity: 20  },
            { freq: 10, intensity: 40  },
            { freq: 10, intensity: 60  },
            { freq: 10, intensity: 80  },
            { freq: 10, intensity: 100 },
            { freq: 10, intensity: 100 },
            { freq: 10, intensity: 100 },
            { freq: 10, intensity: 0   },
            { freq: 10, intensity: 0   },
            { freq: 10, intensity: 0   },
            { freq: 10, intensity: 0   },
        ],
    },
    tide: {
        name: "潮汐",
        slices: [
            { freq: 10, intensity: 0   },
            { freq: 11, intensity: 16  },
            { freq: 13, intensity: 33  },
            { freq: 14, intensity: 50  },
            { freq: 16, intensity: 66  },
            { freq: 18, intensity: 83  },
            { freq: 19, intensity: 100 },
            { freq: 21, intensity: 92  },
            { freq: 22, intensity: 84  },
            { freq: 24, intensity: 76  },
            { freq: 26, intensity: 68  },
            { freq: 26, intensity: 0   },
            { freq: 27, intensity: 16  },
            { freq: 29, intensity: 33  },
            { freq: 30, intensity: 50  },
            { freq: 32, intensity: 66  },
            { freq: 34, intensity: 83  },
            { freq: 35, intensity: 100 },
            { freq: 37, intensity: 92  },
            { freq: 38, intensity: 84  },
            { freq: 40, intensity: 76  },
            { freq: 42, intensity: 68  },
            { freq: 10, intensity: 0   },
        ],
    },
    steady: {
        name: "持续",
        slices: [
            { freq: 10, intensity: 50 },
            { freq: 10, intensity: 50 },
            { freq: 10, intensity: 50 },
            { freq: 10, intensity: 50 },
        ],
    },
    pulse: {
        name: "脉冲",
        slices: [
            { freq: 10, intensity: 100 },
            { freq: 10, intensity: 0   },
            { freq: 10, intensity: 100 },
            { freq: 10, intensity: 0   },
        ],
    },
    off: {
        name: "停止",
        slices: [
            { freq: 10, intensity: 0 },
            { freq: 10, intensity: 0 },
            { freq: 10, intensity: 0 },
            { freq: 10, intensity: 0 },
        ],
    },
};

// ─── Utility: frequency compression (10..1000 -> 10..240) ──
function compressFrequency(input) {
    if (input >= 10 && input <= 100) return input;
    if (input >= 101 && input <= 600) return Math.floor((input - 100) / 5 + 100);
    if (input >= 601 && input <= 1000) return Math.floor((input - 600) / 10 + 200);
    return 10;
}

function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
}

// ─── Logging ────────────────────────────────────────────────
function log(msg, level = "info") {
    const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    const entry = `[${ts}] ${msg}`;
    state.logEntries.push({ entry, level });
    if (state.logEntries.length > 200) state.logEntries.shift();
    const el = document.getElementById("log-area");
    if (el) {
        el.textContent = state.logEntries.map(e => e.entry).join("\n");
        el.scrollTop = el.scrollHeight;
    }
}

// ─── BLE Connection ─────────────────────────────────────────
async function connect() {
    if (state.connected) {
        log("已经连接，请先断开", "warn");
        return;
    }

    log("正在搜索郊狼 3.0 设备 (47L121000)...");

    try {
        const device = await navigator.bluetooth.requestDevice({
            filters: [{ name: DEVICE_NAME }],
            optionalServices: [SERVICE_COMMAND, SERVICE_BATTERY],
        });

        state.device = device;
        device.addEventListener("gattserverdisconnected", onDisconnected);

        log("设备已选择，正在连接 GATT...");
        const server = await device.gatt.connect();
        state.server = server;

        // Get command service
        const cmdService = await server.getPrimaryService(SERVICE_COMMAND);
        state.writeChar = await cmdService.getCharacteristic(CHAR_WRITE);
        state.notifyChar = await cmdService.getCharacteristic(CHAR_NOTIFY);

        // Subscribe to notifications
        await state.notifyChar.startNotifications();
        state.notifyChar.addEventListener("characteristicvaluechanged", onNotify);
        log("已订阅 0x150B 通知");

        // Get battery service
        try {
            const batService = await server.getPrimaryService(SERVICE_BATTERY);
            state.batteryChar = await batService.getCharacteristic(CHAR_BATTERY);
            const batValue = await state.batteryChar.readValue();
            state.batteryLevel = batValue.getUint8(0);
            log(`电池电量: ${state.batteryLevel}%`);
            await state.batteryChar.startNotifications();
            state.batteryChar.addEventListener("characteristicvaluechanged", onBatteryNotify);
        } catch (e) {
            log("电池服务不可用: " + e.message, "warn");
        }

        state.connected = true;
        updateUI();
        log("连接成功！正在设置安全参数...");

        // Set soft cap immediately on connect
        await sendBF();

        log("安全参数已设置（软上限 A/B = " + state.softCapA + "/" + state.softCapB + "）");
        log("可以使用控制面板操作设备了");

    } catch (e) {
        log("连接失败: " + e.message, "error");
        state.connected = false;
        updateUI();
    }
}

function disconnect() {
    if (state.device && state.device.gatt.connected) {
        stopStreaming();
        state.device.gatt.disconnect();
        onDisconnected();
    }
}

function onDisconnected() {
    state.connected = false;
    state.streaming = false;
    if (state.streamTimer) {
        clearInterval(state.streamTimer);
        state.streamTimer = null;
    }
    state.device = null;
    state.server = null;
    state.writeChar = null;
    state.notifyChar = null;
    state.batteryChar = null;
    updateUI();
    log("设备已断开", "warn");
}

// ─── Notify Handler ─────────────────────────────────────────
function onNotify(event) {
    const data = new Uint8Array(event.target.value.buffer);
    if (data.length < 1) return;

    const cmd = data[0];
    if (cmd === MSG_B1 && data.length >= 4) {
        const seq = data[1];
        const aActual = data[2];
        const bActual = data[3];
        state.intensityA = aActual;
        state.intensityB = bActual;
        updateIntensityUI();

        if (seq > 0 && seq === state.pendingSeq) {
            state.pendingSeq = 0;
            state.inputAllowedA = true;
            state.inputAllowedB = true;
        }
    }
}

function onBatteryNotify(event) {
    const data = new Uint8Array(event.target.value.buffer);
    if (data.length >= 1) {
        state.batteryLevel = data[0];
        document.getElementById("battery-level").textContent = state.batteryLevel + "%";
    }
}

// ─── Command: BF (soft cap + balance) ──────────────────────
async function sendBF() {
    if (!state.writeChar) return;
    const payload = new Uint8Array(7);
    payload[0] = CMD_BF;
    payload[1] = clamp(state.softCapA, 0, 200);
    payload[2] = clamp(state.softCapB, 0, 200);
    payload[3] = clamp(state.balanceFreqA, 0, 255);
    payload[4] = clamp(state.balanceFreqB, 0, 255);
    payload[5] = clamp(state.balanceIntA, 0, 255);
    payload[6] = clamp(state.balanceIntB, 0, 255);
    await writeData(payload);
}

// ─── Command: B0 (waveform + intensity, every 100ms) ───────
async function sendB0() {
    if (!state.writeChar || !state.streaming) return;

    const wf = WAVEFORMS[state.waveformName] || WAVEFORMS.off;
    const slices = wf.slices;

    // Get 4 consecutive slices, wrapping around
    const s0 = slices[state.waveformIndex % slices.length];
    const s1 = slices[(state.waveformIndex + 1) % slices.length];
    const s2 = slices[(state.waveformIndex + 2) % slices.length];
    const s3 = slices[(state.waveformIndex + 3) % slices.length];
    state.waveformIndex = (state.waveformIndex + 4) % slices.length;

    const freqs = [
        compressFrequency(s0.freq),
        compressFrequency(s1.freq),
        compressFrequency(s2.freq),
        compressFrequency(s3.freq),
    ];
    const ints = [
        clamp(s0.intensity, 0, 100),
        clamp(s1.intensity, 0, 100),
        clamp(s2.intensity, 0, 100),
        clamp(s3.intensity, 0, 100),
    ];

    // Build interp + setpoint
    let interp = INTERP_NONE;
    let setpointA = 0;
    let setpointB = 0;
    let seq = 0;

    // Process accumulated intensity changes for A
    if (state.inputAllowedA && state.accumA !== 0) {
        if (state.accumA > 0) {
            interp |= INTERP_A_REL_ADD;
            setpointA = Math.abs(state.accumA);
        } else {
            interp |= INTERP_A_REL_SUB;
            setpointA = Math.abs(state.accumA);
        }
        state.seqCounter = (state.seqCounter + 1) & 0x0f;
        if (state.seqCounter === 0) state.seqCounter = 1;
        seq = state.seqCounter;
        state.pendingSeq = seq;
        state.inputAllowedA = false;
        state.accumA = 0;
    }

    // Process accumulated intensity changes for B
    if (state.inputAllowedB && state.accumB !== 0) {
        if (state.accumB > 0) {
            interp |= INTERP_B_REL_ADD;
            setpointB = Math.abs(state.accumB);
        } else {
            interp |= INTERP_B_REL_SUB;
            setpointB = Math.abs(state.accumB);
        }
        if (seq === 0) {
            state.seqCounter = (state.seqCounter + 1) & 0x0f;
            if (state.seqCounter === 0) state.seqCounter = 1;
            seq = state.seqCounter;
        }
        state.pendingSeq = seq;
        state.inputAllowedB = false;
        state.accumB = 0;
    }

    // Build B0 payload (20 bytes)
    const payload = new Uint8Array(20);
    payload[0] = CMD_B0;
    payload[1] = ((seq & 0x0f) << 4) | (interp & 0x0f);
    payload[2] = clamp(setpointA, 0, 200);
    payload[3] = clamp(setpointB, 0, 200);

    // Channel A waveform
    const channel = state.waveformChannel;
    if (channel === "A" || channel === "AB") {
        payload[4]  = freqs[0]; payload[5]  = freqs[1]; payload[6]  = freqs[2]; payload[7]  = freqs[3];
        payload[8]  = ints[0];  payload[9]  = ints[1];  payload[10] = ints[2];  payload[11] = ints[3];
    } else {
        // Disable A channel by sending invalid intensity
        payload[4]  = 10; payload[5]  = 10; payload[6]  = 10; payload[7]  = 10;
        payload[8]  = 0;  payload[9]  = 0;  payload[10] = 0;  payload[11] = 101;
    }

    // Channel B waveform
    if (channel === "B" || channel === "AB") {
        payload[12] = freqs[0]; payload[13] = freqs[1]; payload[14] = freqs[2]; payload[15] = freqs[3];
        payload[16] = ints[0];  payload[17] = ints[1];  payload[18] = ints[2];  payload[19] = ints[3];
    } else {
        // Disable B channel
        payload[12] = 10; payload[13] = 10; payload[14] = 10; payload[15] = 10;
        payload[16] = 0;  payload[17] = 0;  payload[18] = 0;  payload[19] = 101;
    }

    await writeData(payload);
}

// ─── Write Helper ───────────────────────────────────────────
async function writeData(payload) {
    if (!state.writeChar) return;
    try {
        if (state.writeChar.properties.writeWithoutResponse) {
            await state.writeChar.writeValueWithoutResponse(payload);
        } else {
            await state.writeChar.writeValue(payload);
        }
    } catch (e) {
        log("写入失败: " + e.message, "error");
    }
}

// ─── Streaming Control ──────────────────────────────────────
function startStreaming() {
    if (!state.connected) {
        log("请先连接设备", "warn");
        return;
    }
    if (state.streaming) return;
    state.streaming = true;
    state.waveformIndex = 0;
    sendB0(); // immediate first send
    state.streamTimer = setInterval(sendB0, 100);
    updateUI();
    log("开始输出波形: " + (WAVEFORMS[state.waveformName]?.name || state.waveformName));
}

function stopStreaming() {
    if (!state.streaming) return;
    state.streaming = false;
    if (state.streamTimer) {
        clearInterval(state.streamTimer);
        state.streamTimer = null;
    }

    // Send one final B0 with zero-intensity waveform to stop output
    if (state.writeChar) {
        const payload = new Uint8Array(20);
        payload[0] = CMD_B0;
        payload[1] = 0; // seq=0, interp=none
        payload[2] = 0;
        payload[3] = 0;
        // all-zero waveform = no output
        for (let i = 4; i < 20; i++) payload[i] = 0;
        writeData(payload);
    }
    updateUI();
    log("已停止波形输出");
}

// ─── Intensity Control ─────────────────────────────────────
function changeIntensityA(delta) {
    state.accumA += delta;
    log("A通道强度变化: " + (delta > 0 ? "+" : "") + delta + " (待发: " + state.accumA + ")");
}

function changeIntensityB(delta) {
    state.accumB += delta;
    log("B通道强度变化: " + (delta > 0 ? "+" : "") + delta + " (待发: " + state.accumB + ")");
}

function setIntensityA(val) {
    val = clamp(val, 0, state.softCapA);
    // Use absolute set
    state.seqCounter = (state.seqCounter + 1) & 0x0f;
    if (state.seqCounter === 0) state.seqCounter = 1;
    state.pendingSeq = state.seqCounter;
    state.inputAllowedA = false;

    // Build and send a single B0 with absolute intensity
    if (state.streaming) {
        // Modify accum to use absolute via special flag
        // We'll send it directly
        sendAbsoluteIntensity("A", val);
    } else {
        sendAbsoluteIntensity("A", val);
    }
    log("设置 A 通道强度 = " + val);
}

function setIntensityB(val) {
    val = clamp(val, 0, state.softCapB);
    state.seqCounter = (state.seqCounter + 1) & 0x0f;
    if (state.seqCounter === 0) state.seqCounter = 1;
    state.pendingSeq = state.seqCounter;
    state.inputAllowedB = false;
    sendAbsoluteIntensity("B", val);
    log("设置 B 通道强度 = " + val);
}

async function sendAbsoluteIntensity(channel, value) {
    if (!state.writeChar) return;
    const wf = WAVEFORMS[state.waveformName] || WAVEFORMS.off;
    const slices = wf.slices;
    const s0 = slices[state.waveformIndex % slices.length];
    const s1 = slices[(state.waveformIndex + 1) % slices.length];
    const s2 = slices[(state.waveformIndex + 2) % slices.length];
    const s3 = slices[(state.waveformIndex + 3) % slices.length];

    const freqs = [
        compressFrequency(s0.freq),
        compressFrequency(s1.freq),
        compressFrequency(s2.freq),
        compressFrequency(s3.freq),
    ];
    const ints = [
        clamp(s0.intensity, 0, 100),
        clamp(s1.intensity, 0, 100),
        clamp(s2.intensity, 0, 100),
        clamp(s3.intensity, 0, 100),
    ];

    let interp;
    let setpointA = 0, setpointB = 0;
    if (channel === "A") {
        interp = INTERP_A_ABS;
        setpointA = value;
    } else {
        interp = INTERP_B_ABS;
        setpointB = value;
    }

    const payload = new Uint8Array(20);
    payload[0] = CMD_B0;
    payload[1] = ((state.pendingSeq & 0x0f) << 4) | (interp & 0x0f);
    payload[2] = clamp(setpointA, 0, 200);
    payload[3] = clamp(setpointB, 0, 200);

    const ch = state.waveformChannel;
    if (ch === "A" || ch === "AB") {
        payload[4]  = freqs[0]; payload[5]  = freqs[1]; payload[6]  = freqs[2]; payload[7]  = freqs[3];
        payload[8]  = ints[0];  payload[9]  = ints[1];  payload[10] = ints[2];  payload[11] = ints[3];
    } else {
        payload[4]=10; payload[5]=10; payload[6]=10; payload[7]=10;
        payload[8]=0; payload[9]=0; payload[10]=0; payload[11]=101;
    }
    if (ch === "B" || ch === "AB") {
        payload[12] = freqs[0]; payload[13] = freqs[1]; payload[14] = freqs[2]; payload[15] = freqs[3];
        payload[16] = ints[0];  payload[17] = ints[1];  payload[18] = ints[2];  payload[19] = ints[3];
    } else {
        payload[12]=10; payload[13]=10; payload[14]=10; payload[15]=10;
        payload[16]=0; payload[17]=0; payload[18]=0; payload[19]=101;
    }
    await writeData(payload);
}

function setIntensityZero() {
    if (!state.connected) { log("请先连接设备", "warn"); return; }
    // Send absolute 0 for both channels
    state.seqCounter = (state.seqCounter + 1) & 0x0f;
    if (state.seqCounter === 0) state.seqCounter = 1;
    state.pendingSeq = state.seqCounter;
    state.inputAllowedA = false;
    state.inputAllowedB = false;

    const wf = WAVEFORMS[state.waveformName] || WAVEFORMS.off;
    const slices = wf.slices;
    const s0 = slices[state.waveformIndex % slices.length];
    const s1 = slices[(state.waveformIndex + 1) % slices.length];
    const s2 = slices[(state.waveformIndex + 2) % slices.length];
    const s3 = slices[(state.waveformIndex + 3) % slices.length];
    const freqs = [compressFrequency(s0.freq), compressFrequency(s1.freq), compressFrequency(s2.freq), compressFrequency(s3.freq)];
    const ints = [clamp(s0.intensity,0,100), clamp(s1.intensity,0,100), clamp(s2.intensity,0,100), clamp(s3.intensity,0,100)];

    const payload = new Uint8Array(20);
    payload[0] = CMD_B0;
    payload[1] = ((state.pendingSeq & 0x0f) << 4) | (INTERP_A_ABS | INTERP_B_ABS);
    payload[2] = 0;
    payload[3] = 0;
    const ch = state.waveformChannel;
    if (ch === "A" || ch === "AB") {
        payload[4]=freqs[0]; payload[5]=freqs[1]; payload[6]=freqs[2]; payload[7]=freqs[3];
        payload[8]=ints[0]; payload[9]=ints[1]; payload[10]=ints[2]; payload[11]=ints[3];
    } else {
        payload[4]=10; payload[5]=10; payload[6]=10; payload[7]=10;
        payload[8]=0; payload[9]=0; payload[10]=0; payload[11]=101;
    }
    if (ch === "B" || ch === "AB") {
        payload[12]=freqs[0]; payload[13]=freqs[1]; payload[14]=freqs[2]; payload[15]=freqs[3];
        payload[16]=ints[0]; payload[17]=ints[1]; payload[18]=ints[2]; payload[19]=ints[3];
    } else {
        payload[12]=10; payload[13]=10; payload[14]=10; payload[15]=10;
        payload[16]=0; payload[17]=0; payload[18]=0; payload[19]=101;
    }
    writeData(payload);
    state.intensityA = 0;
    state.intensityB = 0;
    updateIntensityUI();
    log("紧急停止：强度归零！");
}

// ─── Soft Cap Control ──────────────────────────────────────
async function updateSoftCap() {
    const a = parseInt(document.getElementById("softcap-a").value) || 0;
    const b = parseInt(document.getElementById("softcap-b").value) || 0;
    state.softCapA = clamp(a, 0, 200);
    state.softCapB = clamp(b, 0, 200);
    if (state.connected) {
        await sendBF();
        log("软上限已更新: A=" + state.softCapA + ", B=" + state.softCapB);
    } else {
        log("软上限已暂存: A=" + state.softCapA + ", B=" + state.softCapB + "（连接后生效）");
    }
}

// ─── UI Updates ─────────────────────────────────────────────
function updateUI() {
    const connected = state.connected;
    const streaming = state.streaming;

    document.getElementById("btn-connect").disabled = connected;
    document.getElementById("btn-disconnect").disabled = !connected;
    document.getElementById("btn-start").disabled = !connected || streaming;
    document.getElementById("btn-stop").disabled = !connected || !streaming;
    document.getElementById("btn-emergency").disabled = !connected;

    document.getElementById("connection-status").textContent = connected ? "已连接" : "未连接";
    document.getElementById("connection-status").className = connected ? "status-connected" : "status-disconnected";
    document.getElementById("battery-level").textContent = state.batteryLevel + "%";

    const wfSelect = document.getElementById("waveform-select");
    if (wfSelect) wfSelect.disabled = !connected;
    const chSelect = document.getElementById("channel-select");
    if (chSelect) chSelect.disabled = !connected;
}

function updateIntensityUI() {
    document.getElementById("intensity-a").textContent = state.intensityA;
    document.getElementById("intensity-b").textContent = state.intensityB;

    // Update slider positions
    const sliderA = document.getElementById("slider-a");
    const sliderB = document.getElementById("slider-b");
    if (sliderA) sliderA.value = state.intensityA;
    if (sliderB) sliderB.value = state.intensityB;
}

// ─── Init ───────────────────────────────────────────────────
function init() {
    // Web Bluetooth check
    if (!navigator.bluetooth) {
        log("当前浏览器不支持 Web Bluetooth API！请使用 Chrome/Edge（桌面版或 Android 版）", "error");
        document.getElementById("btn-connect").disabled = true;
        return;
    }
    log("DG-LAB Coyote 3.0 控制器已就绪");
    log("协议来源: DG-LAB Open Source (github.com/DG-LAB-OPENSOURCE)");
    log("点击「连接设备」开始");

    // Event listeners
    document.getElementById("btn-connect").addEventListener("click", connect);
    document.getElementById("btn-disconnect").addEventListener("click", disconnect);
    document.getElementById("btn-start").addEventListener("click", startStreaming);
    document.getElementById("btn-stop").addEventListener("click", stopStreaming);
    document.getElementById("btn-emergency").addEventListener("click", setIntensityZero);

    document.getElementById("btn-a-up").addEventListener("click", () => changeIntensityA(+1));
    document.getElementById("btn-a-down").addEventListener("click", () => changeIntensityA(-1));
    document.getElementById("btn-a-up5").addEventListener("click", () => changeIntensityA(+5));
    document.getElementById("btn-a-down5").addEventListener("click", () => changeIntensityA(-5));
    document.getElementById("btn-b-up").addEventListener("click", () => changeIntensityB(+1));
    document.getElementById("btn-b-down").addEventListener("click", () => changeIntensityB(-1));
    document.getElementById("btn-b-up5").addEventListener("click", () => changeIntensityB(+5));
    document.getElementById("btn-b-down5").addEventListener("click", () => changeIntensityB(-5));

    document.getElementById("btn-set-sliders").addEventListener("click", () => {
        const a = parseInt(document.getElementById("slider-a").value);
        const b = parseInt(document.getElementById("slider-b").value);
        if (state.connected) {
            setIntensityA(a);
            setIntensityB(b);
        }
    });

    document.getElementById("btn-update-softcap").addEventListener("click", updateSoftCap);

    document.getElementById("waveform-select").addEventListener("change", (e) => {
        state.waveformName = e.target.value;
        state.waveformIndex = 0;
        const name = WAVEFORMS[state.waveformName]?.name || state.waveformName;
        log("已选择波形: " + name);
    });

    document.getElementById("channel-select").addEventListener("change", (e) => {
        state.waveformChannel = e.target.value;
        log("输出通道: " + state.waveformChannel);
    });

    updateUI();
    updateIntensityUI();
}

document.addEventListener("DOMContentLoaded", init);
