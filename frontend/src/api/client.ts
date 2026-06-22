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
  if (res.status === 204 || res.headers.get('content-length') === '0') {
    return undefined as unknown as T
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

export interface EnrolledPerson {
  person_id: string
  name: string
  face_count: number
  thumbnail: string | null  // base64 JPEG
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

export interface MiscCluster {
  cluster_id: number
  size: number
  face_ids: string[]
  representative_crops: string[]  // base64 JPEG
}

export interface MiscClustersResult {
  clusters: MiscCluster[]
  total_faces: number
}

export interface GalleryPhoto {
  id: string
  filename: string | null
  date: string | null
  face_obs_id: string
  bbox_x: number | null
  bbox_y: number | null
  bbox_w: number | null
  bbox_h: number | null
}

export interface GalleryPerson {
  id: string
  name: string
  photo_count: number
  photos: GalleryPhoto[]
}

export interface GalleryPlace {
  label: string
  photos: { id: string; filename: string | null; date: string | null }[]
}

export interface GalleryMiscPhoto {
  photo_id: string
  filename: string | null
  date: string | null
  face_ids: string[]
}

export interface GalleryData {
  persons: GalleryPerson[]
  places: GalleryPlace[]
  misc: GalleryMiscPhoto[]
}

export interface SyncStatus {
  pending_count: number
  mismatches: { person_name: string; db_count: number; drive_count: number }[]
}

export interface SyncResult {
  synced: number
  failed: { correction_id: string; error: string }[]
}

export interface BodyProgress {
  status: 'waiting' | 'running' | 'done' | 'error'
  step?: 'loading_model' | 'detecting'
  processed?: number
  total?: number
  bodies_found?: number
  matched?: number
  unmatched?: number
  error?: string
}

export interface OutfitMatch {
  id: string
  photo_id: string
  photo_name: string | null
  bbox_x: number | null
  bbox_y: number | null
  bbox_w: number | null
  bbox_h: number | null
  suggested_person_id: string
  suggested_person_name: string
  suggestion_confidence: number | null
}

export interface Misclassification {
  id: string
  face_observation_id: string
  photo_id: string
  photo_name: string | null
  face_crop: string | null
  current_person_id: string
  current_person_name: string
  outfit_suggests_id: string
  outfit_suggests_name: string
  outfit_correlation: number | null
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
    dismissMisc: (tripId: string, faceId: string) =>
      request<{ dismissed: boolean }>(
        `/review/${tripId}/misc/${faceId}/dismiss`,
        { method: 'POST' }
      ),
    miscClusters: (tripId: string) =>
      request<MiscClustersResult>(`/review/${tripId}/misc-clusters`),
    bulkAssign: (tripId: string, faceIds: string[], personId: string) =>
      request<{ assigned: number; person_id: string }>(
        `/review/${tripId}/misc-bulk-assign`,
        { method: 'POST', body: JSON.stringify({ face_ids: faceIds, person_id: personId }) }
      ),
    bulkDismiss: (tripId: string, faceIds: string[]) =>
      request<{ dismissed: number }>(
        `/review/${tripId}/misc-bulk-dismiss`,
        { method: 'POST', body: JSON.stringify({ face_ids: faceIds }) }
      ),
  },
  gallery: {
    get: (tripId: string) => request<GalleryData>(`/trips/${tripId}/gallery`),
    cover: (tripId: string) => `${BASE}/trips/${tripId}/cover`,
  },
  photos: {
    imageUrl: (photoId: string, tripId: string) => `${BASE}/photos/${photoId}/image?trip_id=${tripId}`,
    thumbnailUrl: (photoId: string, tripId: string, w = 480) => `${BASE}/photos/${photoId}/thumbnail?trip_id=${tripId}&w=${w}`,
    faceUrl: (photoId: string, faceId: string) => `${BASE}/photos/${photoId}/face/${faceId}`,
    updateSceneLabel: (photoId: string, tripId: string, sceneLabel: string) =>
      request<{ scene_label: string }>(
        `/photos/${photoId}/scene-label`,
        { method: 'PATCH', body: JSON.stringify({ trip_id: tripId, scene_label: sceneLabel }) }
      ),
  },
  sync: {
    reassign: (faceObsId: string, newPersonId: string) =>
      request<{ correction_id: string; pending_count: number }>(
        `/face-observations/${faceObsId}/reassign`,
        { method: 'PATCH', body: JSON.stringify({ new_person_id: newPersonId }) }
      ),
    syncTrip: (tripId: string) =>
      request<SyncResult>(`/trips/${tripId}/sync`, { method: 'POST' }),
    syncStatus: (tripId: string) =>
      request<SyncStatus>(`/trips/${tripId}/sync-status`),
    clearCache: (tripId: string) =>
      request<{ freed_bytes: number }>(`/trips/${tripId}/cache`, { method: 'DELETE' }),
  },
  body: {
    run: (tripId: string) =>
      request<{ status: string }>(`/body/${tripId}/run`, { method: 'POST' }),
    streamProgress: (tripId: string, onProgress: (p: BodyProgress) => void, onDone: () => void) => {
      const es = new EventSource(`${BASE}/body/${tripId}/progress`)
      es.onmessage = (e) => {
        const data: BodyProgress = JSON.parse(e.data)
        onProgress(data)
        if (data.status === 'done' || data.status === 'error') { es.close(); onDone() }
      }
      es.onerror = () => { es.close(); onDone() }
      return () => es.close()
    },
    outfitMatches: (tripId: string) =>
      request<OutfitMatch[]>(`/body/${tripId}/outfit-matches`),
    unmatchedCropUrl: (tripId: string, umId: string) =>
      `${BASE}/body/${tripId}/unmatched/${umId}/crop`,
    confirmOutfitMatch: (tripId: string, umId: string, personId?: string) =>
      request<{ assigned: boolean; person_id: string }>(
        `/body/${tripId}/outfit-matches/${umId}/confirm`,
        { method: 'POST', body: JSON.stringify({ person_id: personId ?? null }) }
      ),
    dismissOutfitMatch: (tripId: string, umId: string) =>
      request<{ dismissed: boolean }>(
        `/body/${tripId}/outfit-matches/${umId}/dismiss`,
        { method: 'POST' }
      ),
    detectMisclassifications: (tripId: string, similarityThreshold?: number, margin?: number) => {
      const params = new URLSearchParams()
      if (similarityThreshold !== undefined) params.set('similarity_threshold', String(similarityThreshold))
      if (margin !== undefined) params.set('margin', String(margin))
      const qs = params.toString()
      return request<{ count: number; message?: string }>(
        `/body/${tripId}/detect-misclassifications${qs ? `?${qs}` : ''}`,
        { method: 'POST' }
      )
    },
    misclassifications: (tripId: string) =>
      request<Misclassification[]>(`/body/${tripId}/misclassifications`),
    keepClassification: (tripId: string, pmId: string) =>
      request<{ kept: boolean }>(
        `/body/${tripId}/misclassifications/${pmId}/keep`,
        { method: 'POST' }
      ),
    reassignMisclassification: (tripId: string, pmId: string, newPersonId?: string) =>
      request<{ reassigned: boolean; new_person_id: string }>(
        `/body/${tripId}/misclassifications/${pmId}/reassign`,
        { method: 'POST', body: JSON.stringify({ new_person_id: newPersonId ?? null }) }
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
    persons: (tripId: string) =>
      request<EnrolledPerson[]>(`/enrollment/${tripId}/persons`),
    deletePerson: (tripId: string, personId: string) =>
      request<{ deleted: string }>(`/enrollment/${tripId}/persons/${personId}`, { method: 'DELETE' }),
  },
}
