import Corestore from 'corestore'
import ram from 'random-access-memory'
import seedrandom from 'seedrandom'
import random from 'random'
import pump from 'pump'
import codecs from 'codecs'
import Autobase from 'autobase'
import Hyperbee from 'hyperbee'

export default class Autobee {
  constructor ({inputs, defaultInput, indexes, valueEncoding} = {}) {
    inputs = inputs || []
    valueEncoding = valueEncoding || 'json'
    this._valueEncoding = valueEncoding
    this._valueEncoder = codecs(valueEncoding)
    
    this.autobase = new Autobase(inputs, {indexes, input: defaultInput})

    const index = this.autobase.createRebasedIndex({
      unwrap: true,
      apply: this._apply.bind(this)
    })
    this.indexBee = new Hyperbee(index, {
      extension: false,
      keyEncoding: 'utf-8',
      valueEncoding
    })
  }

  async ready () {
    await this.autobase.ready()
    await this.indexBee.ready()
  }

  get writable () {
    return !!this.autobase.inputs.find(core => core.writable)
  }

  async get (...args) {
    return await this.indexBee.get(...args)
  }

  async put (key, value, opts) {
    value = this._valueEncoder.encode(value)
    return await this.autobase.append(JSON.stringify({op: 'put', key, value}))
  }

  async del (key, opts) {
    return await this.autobase.append(JSON.stringify({op: 'del', key}))
  }

  async _apply (batch, clocks, change) {
    console.log('never called')
  }
}

class Sim {
  constructor () {
    this.nodes = []
    this.connections = new Set()
  }

  async setup (numNodes) {
    // create the nodes
    for (let i = 0; i < numNodes; i++) {
      const node = new SimNode(numNodes)
      node.idx = i
      this.nodes.push(node)
    }

    // create the writable writer cores
    for (let i = 0; i < numNodes; i++) {
      this.nodes[i].writers[i] = this.nodes[i].store.get({name: `writer${i}`})
      await this.nodes[i].writers[i].ready()
    }

    // create the first node's index core
    this.nodes[0].index = this.nodes[0].store.get({name: 'index'})
    await this.nodes[0].index.ready()

    // create readonly instances of each writer core
    for (let i = 0; i < numNodes; i++) {
      for (let j = 0; j < numNodes; j++) {
        if (!this.nodes[i].writers[j]) {
          this.nodes[i].writers[j] = this.nodes[i].store.get(this.nodes[j].writers[j].key)
        }
      }
    }

    // create the readonly instances of the index core
    for (let i = 1; i < numNodes; i++) {
      this.nodes[i].index = this.nodes[i].store.get(this.nodes[0].index.key)
    }

    // create the autobees
    for (let i = 0; i < numNodes; i++) {
      this.nodes[i].autobee = new Autobee({inputs: this.nodes[i].writers, defaultInput: this.nodes[i].writers[i], indexes: this.nodes[i].index})
      await this.nodes[i].autobee.ready()
    }
  }

  connected (a, b, v = undefined) {
    if (a === b) return true
    if (a > b) [b, a] = [a, b]
    const key = `${a}:${b}`
    if (typeof v === 'undefined') return this.connections.has(key)
    if (v) this.connections.add(key)
    else this.connections.delete(key)
  }

  heal (a, b) {
    if (a === b) return
    if (a > b) [b, a] = [a, b]
    console.log(a, '<--->', b)
    if (!this.connected(a, b)) {
      this.nodes[a].connect(this.nodes[b])
      this.connected(a, b, true)
    }
  }

  unheal (a, b) {
    if (a === b) return
    if (a > b) [b, a] = [a, b]
    console.log(a,'<-/->', b)
    if (this.connected(a, b)) {
      this.nodes[a].disconnect(this.nodes[b])
      this.connected(a, b, false)
    }
  }

  async put (writerIndex, key) {
    console.log(`${writerIndex}.put(${key})`)
    await this.nodes[writerIndex].autobee.put(String(key), `writer${writerIndex}`)
  }

  async del (writerIndex, key) {
    console.log(`${writerIndex}.del(${key})`)
    await this.nodes[writerIndex].autobee.del(String(key))
  }
}

class SimNode {
  constructor (numNodes) {
    this.streams = new Map()
    this.store = new Corestore(ram)
    this.writers = Array(numNodes)
    this.index = undefined,
    this.autobee = undefined
  }

  connect (node) {
    const s = this.store.replicate(true)
    pump(s, node.store.replicate(false), s, err => {
      console.log('Replication error', err)
    })
    this.streams.set(node, s)
  }

  disconnect (node) {
    this.streams.get(node)?.destroy()
    this.streams.delete(node)
  }
}

const seed = String((Math.random() * 1e9)|0)
console.log('FUZZER SEED:', seed)
random.use(seedrandom(seed))
const sim = new Sim()
await sim.setup(10)
for (let i = 0; i < 1000; i++) {
  // 3 sided die: heal, unheal, do nothing
  switch (random.int(0, 2)) {
    case 0:
      sim.heal(random.int(0, 9), random.int(0, 9))
      break
    case 1:
      sim.unheal(random.int(0, 9), random.int(0, 9))
      break
    case 2:
      // do nothing
      break
  }

  // 4 sided die: 0-2, write; 3, delete
  const writeOrDelete = random.int(0, 3)
  const writerIndex = random.int(0, 9)
  const key = random.int(0, 9)
  switch (writeOrDelete) {
    case 0:
    case 1:
    case 2:
      await sim.put(writerIndex, key)
      break
    case 3:
      await sim.del(writerIndex, key)
      break
  }
}

console.log('End reached!')