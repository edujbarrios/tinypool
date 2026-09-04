import { AgentPool } from '../../dist/agent.js'

const agents = new AgentPool({
  capabilities: ['math.use'],
  limits: {
    maxToolCalls: 3,
  },
})

agents.tools.register({
  name: 'math.add',
  description: 'Add two numbers',
  capabilities: ['math.use'],
  execute({ a, b }) {
    return a + b
  },
})

const context = agents.createContext({
  agentId: 'calculator-agent',
})

const result = await context.tool('math.add', {
  a: 20,
  b: 22,
})

console.log({
  agentId: context.id,
  result,
  toolCalls: context.toolCalls,
})

await agents.destroy()
