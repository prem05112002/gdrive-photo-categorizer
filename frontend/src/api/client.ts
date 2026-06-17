export interface Trip {
  id: string
  name: string
  drive_folder_id: string
  status: string
  expected_member_count: number | null
  output_folder_id: string | null
  last_good_status: string | null
  error_message: string | null
  created_at: string
  photo_count: number
  raw_count: number
  video_count: number
  duplicate_count: number
}

export interface CreateTripPayload {
  name: string
  drive_folder_url: string
  expected_member_count?: number
}

export interface IngestionProgress {
  status: 'waiting' | 'listing' | 'downloading' | 'processing' | 'done' | 'error'
  total_files: number
  downloaded: number
  processed: number
  raw_count: number
  video_count: number
  duplicate_count: number
  error?: string
}

const BASE = '/api'

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.detail ?? `HTTP ${res.status}`)
  }
  return res.json()
}

export interface FaceStats {
  total_faces: number
  photos_with_faces: number
  group_photo_candidates: number
}

export interface GroupPhoto {
  id: string
  file_name: string
  face_count: number
  face_crops: string[]  // base64 JPEG
}

export interface FaceCluster {
  cluster_id: number
  size: number
  is_singleton: boolean
  face_ids: string[]
  representative_crops: string[]  // base64 JPEG
}

export interface ClusterResult {
  clusters: FaceCluster[]
  total_faces_pending: number
  named: number
  expected: number | null
}

export interface Coverage {
  named: number
  expected: number | null
}

export interface ClassifyProgress {
  status: 'waiting' | 'running' | 'done' | 'error'
  step?: 'face_match' | 'loading_scene_model' | 'scene_classify'
  scene_total?: number
  scene_processed?: number
  faces_matched?: number
  scenes_labeled?: number
  error?: string
}

export interface UploadProgress {
  status: 'waiting' | 'running' | 'done' | 'error'
  total?: number
  uploaded?: number
  current?: string
  total_shortcuts?: number
  output_url?: string
  error?: string
}

export interface ClassifyResults {
  persons: { name: string; person_id: string; photo_count: number }[]
  scene_counts: Record<string, number>
  misc_count: number
}

export interface MiscFace {
  face_id: string
  photo_id: string
  photo_name: string | null
  face_crop: string | null
  confidence: number | null
}

export interface MiscResponse {
  faces: MiscFace[]
  count: number
}

export const api = {
  trips: {
    list: () => request<Trip[]>('/trips/'),
    create: (payload: CreateTripPayload) =>
      request<Trip>('/trips/', { method: 'POST', body: JSON.stringify(payload) }),
    get: (id: string) => request<Trip>(`/trips/${id}`),
    delete: (id: string) => request<void>(`/trips/${id}`, { method: 'DELETE' }),
  },
  processing: {
    startIngestion: (tripId: string) =>
      request<{ status: string }>(`/processing/${tripId}/ingest`, { method: 'POST' }),
    streamProgress: (tripId: string, onProgress: (p: IngestionProgress) => void, onDone: () => void) => {
      const es = new EventSource(`${BASE}/processing/${tripId}/progress`)
      es.onmessage = (e) => {
        const data: IngestionProgress = JSON.parse(e.data)
        onProgress(data)
        if (data.status === 'done' || data.status === 'error') { es.close(); onDone() }
      }
      es.onerror = () => { es.close(); onDone() }
      return () => es.close()
    },
  },
  pipeline: {
    startFaceExtraction: (tripId: string) =>
      request<{ status: string }>(`/pipeline/${tripId}/faces`, { method: 'POST' }),
    faceStats: (tripId: string) =>
      request<FaceStats>(`/pipeline/${tripId}/faces/stats`),
    streamFaceProgress: (tripId: string, onProgress: (p: any) => void, onDone: () => void) => {
      const es = new EventSource(`${BASE}/pipeline/${tripId}/faces/progress`)
      es.onmessage = (e) => {
        const data = JSON.parse(e.data)
        onProgress(data)
        if (data.status === 'done' || data.status === 'error') { es.close(); onDone() }
      }
      es.onerror = () => { es.close(); onDone() }
      return () => es.close()
    },
  },
  classify: {
    run: (tripId: string) =>
      request<{ status: string }>(`/classify/${tripId}/run`, { method: 'POST' }),
    results: (tripId: string) =>
      request<ClassifyResults>(`/classify/${tripId}/results`),
    streamProgress: (tripId: string, onProgress: (p: ClassifyProgress) => void, onDone: () => void) => {
      const es = new EventSource(`${BASE}/classify/${tripId}/progress`)
      es.onmessage = (e) => {
        const data: ClassifyProgress = JSON.parse(e.data)
        onProgress(data)
        if (data.status === 'done' || data.status === 'error') { es.close(); onDone() }
      }
      es.onerror = () => { es.close(); onDone() }
      return () => es.close()
    },
    upload: (tripId: string) =>
      request<{ status: string }>(`/classify/${tripId}/upload`, { method: 'POST' }),
    streamUploadProgress: (tripId: string, onProgress: (p: UploadProgress) => void, onDone: () => void) => {
      const es = new EventSource(`${BASE}/classify/${tripId}/upload/progress`)
      es.onmessage = (e) => {
        const data: UploadProgress = JSON.parse(e.data)
        onProgress(data)
        if (data.status === 'done' || data.status === 'error') { es.close(); onDone() }
      }
      es.onerror = () => { es.close(); onDone() }
      return () => es.close()
    },
  },
  review: {
    getMisc: (tripId: string) =>
      request<MiscResponse>(`/review/${tripId}/misc`),
    assignMisc: (tripId: string, faceId: string, personId: string) =>
      request<{ assigned: boolean; person_id: string; person_name: string }>(
        `/review/${tripId}/misc/${faceId}/assign`,
        { method: 'POST', body: JSON.stringify({ person_id: personId }) }
      ),
    createPersonFromMisc: (tripId: string, faceId: string, name: string) =>
      request<{ person_id: string; name: string }>(
        `/review/${tripId}/misc/${faceId}/create`,
        { method: 'POST', body: JSON.stringify({ name }) }
      ),
  },
  enrollment: {
    groupPhotos: (tripId: string) =>
      request<GroupPhoto[]>(`/enrollment/${tripId}/group-photos`),
    clusters: (tripId: string) =>
      request<ClusterResult>(`/enrollment/${tripId}/clusters`),
    nameCluster: (tripId: string, name: string, faceIds: string[]) =>
      request<{ person_id: string; name: string }>(`/enrollment/${tripId}/name-cluster`, {
        method: 'POST',
        body: JSON.stringify({ name, face_ids: faceIds }),
      }),
    dismissCluster: (tripId: string, faceIds: string[]) =>
      request<{ dismissed: number }>(`/enrollment/${tripId}/dismiss-cluster`, {
        method: 'POST',
        body: JSON.stringify({ face_ids: faceIds }),
      }),
    coverage: (tripId: string) =>
      request<Coverage>(`/enrollment/${tripId}/coverage`),
  },
}
