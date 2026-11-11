import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { getEditContext } from '../db/db'
import { restore, softDelete } from '../db/repo'
import type { TableName } from '../model/types'

const UNDO_MS = 5000

type UndoDelete = (table: TableName, id: string, label: string) => void

interface Toast {
  seq: number
  label: string
  /** Set for a successful delete; absent when the delete itself failed. */
  target?: { table: TableName; id: string }
}

const UndoContext = createContext<UndoDelete | null>(null)

/** Mount once near the app root so the toast survives navigation. */
export function UndoProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null)

  const undoDelete = useCallback<UndoDelete>((table, id, label) => {
    void (async () => {
      try {
        await softDelete(table, id, await getEditContext())
        // A newer delete replaces this toast; the earlier delete simply stays deleted.
        setToast((prev) => ({ seq: (prev?.seq ?? 0) + 1, label, target: { table, id } }))
      } catch {
        setToast((prev) => ({ seq: (prev?.seq ?? 0) + 1, label }))
      }
    })()
  }, [])

  // The timer restarts for every new toast (seq) and is cleared on replacement or unmount.
  const seq = toast?.seq
  useEffect(() => {
    if (seq === undefined) return
    const timer = setTimeout(() => setToast(null), UNDO_MS)
    return () => clearTimeout(timer)
  }, [seq])

  async function onUndo() {
    const target = toast?.target
    if (!target) return
    setToast(null)
    await restore(target.table, target.id, await getEditContext())
  }

  return (
    <UndoContext.Provider value={undoDelete}>
      {children}
      {toast && (
        <div className="toast" role="status">
          {toast.target ? (
            <>
              <span>{toast.label} deleted</span>
              <span aria-hidden="true"> · </span>
              <button type="button" className="toast-undo" onClick={() => void onUndo()}>
                Undo
              </button>
            </>
          ) : (
            <span>Could not delete {toast.label.toLowerCase()}</span>
          )}
        </div>
      )}
    </UndoContext.Provider>
  )
}

// The task's contract puts the hook next to its provider, so one file exports both.
// oxlint-disable-next-line react/only-export-components
export function useUndoDelete(): UndoDelete {
  const fn = useContext(UndoContext)
  if (!fn) throw new Error('useUndoDelete must be used inside <UndoProvider>')
  return fn
}
