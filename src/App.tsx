import { HashRouter, Route, Routes } from 'react-router-dom'
import EntryForm from './ui/EntryForm'
import Garage from './ui/Garage'
import Header from './ui/Header'
import Placeholder from './ui/Placeholder'

export default function App() {
  return (
    <HashRouter>
      <Header />
      <main className="app-main">
        <Routes>
          <Route path="/" element={<Garage />} />
          <Route path="/entry/new" element={<EntryForm />} />
          <Route path="/entry/:id/edit" element={<EntryForm />} />
          <Route path="/vehicle/:id/:tab?" element={<Placeholder title="Vehicle" />} />
          <Route path="/issue/:id" element={<Placeholder title="Issue" />} />
          <Route path="/search" element={<Placeholder title="Search" />} />
          <Route path="/settings" element={<Placeholder title="Settings" />} />
          <Route path="*" element={<Placeholder title="Not found" />} />
        </Routes>
      </main>
    </HashRouter>
  )
}
