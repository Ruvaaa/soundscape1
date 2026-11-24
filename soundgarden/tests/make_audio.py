"""Generate known test signals so analysis results can be checked against ground truth."""
import os
import wave
import numpy as np

SR = 44100
OUT = os.path.join(os.path.dirname(__file__), "fixtures")
os.makedirs(OUT, exist_ok=True)


def write(name, data):
    data = np.clip(data, -1, 1)
    pcm = (data * 32767).astype("<i2")
    path = os.path.join(OUT, name)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    return path


def t(sec):
    return np.arange(int(sec * SR)) / SR


def tone(freqs, sec, amp):
    x = t(sec)
    return sum(np.sin(2 * np.pi * f * x) for f in freqs) * (amp / len(freqs))


def fade(x, ms=15):
    n = int(SR * ms / 1000)
    x[:n] *= np.linspace(0, 1, n)
    x[-n:] *= np.linspace(1, 0, n)
    return x


# 12 s: 3 s bass, 3 s mids, 3 s treble, 3 s silence (steady tones, so no beats expected)
bands = np.concatenate([
    fade(tone([55, 110], 3, 0.6)),
    fade(tone([1000, 2000], 3, 0.5)),
    fade(tone([8000, 10000], 3, 0.5)),
    np.zeros(int(3 * SR)),
])
write("bands.wav", bands)

# 10 s of 120 BPM kicks (20 kicks, one every 0.5 s)
kick_len = int(0.25 * SR)
k = t(0.25)
freq = 45 + 90 * np.exp(-k * 30)
kick = np.sin(2 * np.pi * np.cumsum(freq) / SR) * np.exp(-k * 14) * 0.9
beats = np.zeros(int(10 * SR))
for i in range(20):
    s = int(i * 0.5 * SR) + int(0.25 * SR)  # start a quarter second in
    beats[s:s + kick_len] += kick[: len(beats[s:s + kick_len])]
write("kicks_120bpm.wav", beats)

# a short, quiet-room-noise-level file to check the silence gate does not animate on noise
rng = np.random.default_rng(1)
write("room_noise.wav", rng.normal(0, 0.0012, int(4 * SR)))
print("fixtures written to", OUT)
