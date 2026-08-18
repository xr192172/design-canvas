package sample

// Camera 插桩器黄金样例（Go）
// 语义清单见 _reference.md —— 与 sample.ts 语义等价。
// Go 无 catch：吞错语义用 err != nil 分支表达（expected 中体现为 exit(false)，无 catch 探针）。

import "os"

func AddTwo(a, b int) int {
	return a + b
}

func Clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func Log(msg string) {
	if msg == "" {
		return
	}
	os.Stdout.WriteString(msg + "\n")
}

func SaveQuiet(path, data string) bool {
	if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
		return false
	}
	return true
}

func Main() {
	Log(intToString(AddTwo(1, 2)))
	Log(intToString(Clamp(5, 0, 10)))
	SaveQuiet(".tmp-camera-sample.txt", "ok")
}

func intToString(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
