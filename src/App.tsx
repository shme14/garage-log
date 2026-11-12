import { HashRouter, Route, Routes } from 'react-router-dom'
import EntryForm from './ui/EntryForm'
import Garage from './ui/Garage'
import Header from './ui/Header'
import IssuePage from './ui/IssuePage'
import Placeholder from './ui/Placeholder'
import { UndoProvider } from './ui/UndoToast'
import VehicleEditor from './ui/VehicleEditor'
import VehiclePage from './ui/VehiclePage'

export default function App() {
  return (
    <HashRouter>
      <UndoProvider>
        <Header />
        <main className="app-main">
          <Routes>
            <Route path="/" element={<Garage />} />
            <Route path="/entry/new" element={<EntryForm />} />
            <Route path="/entry/:id/edit" element={<EntryForm />} />
            <Route path="/vehicles/new" element={<VehicleEditor />} />
            <Route path="/vehicles/:id/edit" element={<VehicleEditor />} />
            <Route path="/vehicle/:id/:tab?" element={<VehiclePage />} />
            <Route path="/issue/:id" element={<IssuePage />} />
            <Route path="/search" element={<Placeholder title="Search" />} />
            <Route path="/settings" element={<Placeholder title="Settings" />} />
            <Route path="*" element={<Placeholder title="Not found" />} />
          </Routes>
        </main>
      </UndoProvider>
    </HashRouter>
  )
}
