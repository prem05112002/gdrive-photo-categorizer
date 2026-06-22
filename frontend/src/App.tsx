import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Home } from './pages/Home'
import { TripDetail } from './pages/TripDetail'
import { Enroll } from './pages/Enroll'
import { Review } from './pages/Review'
import { Gallery } from './pages/Gallery'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/trips/:id" element={<TripDetail />} />
        <Route path="/trips/:id/enroll" element={<Enroll />} />
        <Route path="/trips/:id/review" element={<Review />} />
        <Route path="/trips/:id/gallery" element={<Gallery />} />
      </Routes>
    </BrowserRouter>
  )
}
