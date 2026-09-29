// Shared wording for face clusters (Enroll, Review, FaceLightbox).

// A person appears once per photo, so faces == photos almost always; only spell out both when they differ
export function countLabel(c: { size: number; photo_count: number }): string {
  const photos = `${c.photo_count} photo${c.photo_count !== 1 ? 's' : ''}`
  return c.size === c.photo_count ? photos : `${c.size} faces in ${photos}`
}
