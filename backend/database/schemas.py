from pydantic import BaseModel
from datetime import datetime
from typing import Optional


class TripCreate(BaseModel):
    name: str
    drive_folder_url: str
    expected_member_count: Optional[int] = None


class TripResponse(BaseModel):
    id: str
    name: str
    drive_folder_id: str
    status: str
    expected_member_count: Optional[int]
    output_folder_id: Optional[str] = None
    last_good_status: Optional[str] = None
    error_message: Optional[str] = None
    created_at: datetime
    photo_count: int = 0
    raw_count: int = 0
    video_count: int = 0
    duplicate_count: int = 0

    model_config = {"from_attributes": True}


class PhotoResponse(BaseModel):
    id: str
    drive_file_name: Optional[str]
    file_type: Optional[str]
    is_raw: bool
    is_duplicate: bool
    face_count: int
    exif_device: Optional[str]

    model_config = {"from_attributes": True}


class IngestionProgress(BaseModel):
    trip_id: str
    status: str                 # listing | downloading | processing | done | error
    total_files: int = 0
    downloaded: int = 0
    processed: int = 0
    raw_count: int = 0
    duplicate_count: int = 0
    error: Optional[str] = None
