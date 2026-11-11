import { Link } from 'react-router-dom'
import SyncChip from './SyncChip'

export default function Header() {
  return (
    <header className="app-header">
      <Link to="/" className="app-title">
        Garage Log
      </Link>
      <SyncChip />
      <nav className="app-nav">
        <Link to="/search" className="nav-link">
          Search
        </Link>
        <Link to="/settings" className="nav-link">
          Settings
        </Link>
      </nav>
    </header>
  )
}
