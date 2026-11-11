import { useLiveQuery } from 'dexie-react-hooks'
import { useState, type FormEvent } from 'react'
import { db, getEditContext } from '../db/db'
import { create, todosForVehicle, update } from '../db/repo'
import type { BaseRecord, Todo } from '../model/types'
import { useUndoDelete } from './UndoToast'

interface Props {
  vehicleId: string
  /** Given: this issue's todos. Omitted: the vehicle's todos that belong to no issue. */
  issueId?: string
}

export default function TodoList({ vehicleId, issueId }: Props) {
  const undoDelete = useUndoDelete()
  const [showDone, setShowDone] = useState(false)
  const [text, setText] = useState('')

  const todos = useLiveQuery(
    async () => (await todosForVehicle(vehicleId)).filter((t) => t.issueId === issueId),
    [vehicleId, issueId],
  )

  const open = todos?.filter((t) => !t.done) ?? []
  const done = todos?.filter((t) => t.done) ?? []

  async function toggle(todo: Todo) {
    // Re-read so a concurrent sync merge isn't overwritten with a stale copy.
    const fresh = (await db.todos.get(todo.id)) ?? todo
    await update<Todo>('todos', { ...fresh, done: !fresh.done }, await getEditContext())
  }

  async function onAdd(ev: FormEvent) {
    ev.preventDefault()
    const trimmed = text.trim()
    if (trimmed === '') return
    setText('')
    const fields: Omit<Todo, keyof BaseRecord> =
      { vehicleId, text: trimmed, done: false }
    if (issueId !== undefined) fields.issueId = issueId
    await create<Todo>('todos', fields, await getEditContext())
  }

  const row = (todo: Todo) => (
    <li key={todo.id} className="todo-row">
      <label className="check todo-check">
        <input type="checkbox" checked={todo.done} onChange={() => void toggle(todo)} />
        <span className={todo.done ? 'todo-text todo-done' : 'todo-text'}>{todo.text}</span>
      </label>
      <button
        type="button"
        className="icon-btn"
        aria-label={`Delete todo ${todo.text}`}
        onClick={() => undoDelete('todos', todo.id, 'Todo')}
      >
        ×
      </button>
    </li>
  )

  return (
    <div className="todo-list">
      {todos && open.length === 0 && <p className="muted">No open todos.</p>}
      {open.length > 0 && <ul className="plain-list">{open.map(row)}</ul>}
      {done.length > 0 && (
        <>
          <button
            type="button"
            className="link-btn"
            aria-expanded={showDone}
            onClick={() => setShowDone((s) => !s)}
          >
            {showDone ? `Hide done (${done.length})` : `Show done (${done.length})`}
          </button>
          {showDone && <ul className="plain-list">{done.map(row)}</ul>}
        </>
      )}
      <form className="inline-add" onSubmit={(ev) => void onAdd(ev)}>
        <input
          type="text"
          aria-label="Add todo"
          placeholder="Add a todo"
          value={text}
          onChange={(ev) => setText(ev.target.value)}
        />
        <button type="submit" className="btn" disabled={text.trim() === ''}>
          Add todo
        </button>
      </form>
    </div>
  )
}
