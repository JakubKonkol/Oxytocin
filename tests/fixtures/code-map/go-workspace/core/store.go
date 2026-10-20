package storage

type Writer interface { Save(value int) }
type Store struct { Value int; hidden int }
type Alias = Store
const Default = 1
var Shared Store
func (s *Store) Save(value int) { helper(value) }
func helper(value int) {}
func New() { helper(Default) }
