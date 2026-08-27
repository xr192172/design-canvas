package main

import (
	"io/ioutil"
	"math/rand"
)

// 声明 go 1.21：泛型(1.18)已支持，保持现状即可
func Sum[T ~int | ~float64](xs []T) T {
	var s T
	for _, x := range xs {
		s += x
	}
	return s
}

// 但下面用了 Go 1.16/1.20 起废弃的 API——契约对不上，需重写
func ReadConfig() []byte {
	rand.Seed(1)                        // 废弃(1.20)
	b, _ := ioutil.ReadFile("app.toml") // 废弃(1.16)
	return b
}
