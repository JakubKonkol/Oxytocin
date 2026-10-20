//go:build linux || windows
package main

import (
  data "example.test/core"
  "fmt"
)

func run(w data.Writer, unknown interface{}) {
  var declared data.Store
  declared.Save(1)
  literal := data.Store{}
  literal.Save(2)
  data.New()
  w.Save(3)
  unknown.Save(4)
  fmt.Println("not indexed")
}
func main() { run(nil, nil) }
func shadow(run func()) { run() }
