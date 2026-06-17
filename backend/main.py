from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from database.models import init_db
from api import trips, processing, pipeline, classify, review, persons
from enrollment import router as enrollment_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="Photo Categorizer API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],  # Vite dev server
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(trips.router, prefix="/api/trips", tags=["trips"])
app.include_router(processing.router, prefix="/api/processing", tags=["processing"])
app.include_router(pipeline.router, prefix="/api/pipeline", tags=["pipeline"])
app.include_router(enrollment_router.router, prefix="/api/enrollment", tags=["enrollment"])
app.include_router(classify.router, prefix="/api/classify", tags=["classify"])
app.include_router(review.router, prefix="/api/review", tags=["review"])
app.include_router(persons.router, prefix="/api/persons", tags=["persons"])


@app.get("/api/health")
def health():
    return {"status": "ok"}
