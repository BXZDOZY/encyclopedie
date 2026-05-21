"""
ENCYCLOPÉDIE — Application IA locale
Pipeline RAG pour interroger les encyclopédies françaises d'avant 1939

Architecture :
- FastAPI pour l'API REST
- ChromaDB pour le stockage vectoriel
- Ollama pour le LLM local et les embeddings
- LangChain pour l'orchestration RAG
"""

import os
import time
import hashlib
from pathlib import Path
from typing import Optional

import httpx
from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

import chromadb

# ─── Configuration ────────────────────────────────────────────────────────────

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
RAW_DIR = DATA_DIR / "raw"
CHROMA_DIR = BASE_DIR / "chroma_db"
FRONTEND_DIR = BASE_DIR / "frontend"

OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
EMBED_MODEL = os.getenv("EMBED_MODEL", "nomic-embed-text")
CHAT_MODEL = os.getenv("CHAT_MODEL", "mistral")

CHUNK_SIZE = 800
CHUNK_OVERLAP = 150
TOP_K = 5

# ─── FastAPI App ──────────────────────────────────────────────────────────────

app = FastAPI(
    title="Encyclopédie IA",
    description="Interrogez la connaissance encyclopédique d'avant 1939",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Pydantic Models ─────────────────────────────────────────────────────────

class QuestionRequest(BaseModel):
    question: str = Field(..., min_length=3, max_length=1200)
    top_k: int = Field(default=TOP_K, ge=1, le=12)
    model: Optional[str] = None

class SourceDocument(BaseModel):
    content: str
    source: str
    score: float

class AnswerResponse(BaseModel):
    answer: str
    sources: list[SourceDocument]
    model: str
    elapsed_seconds: float

class IngestResponse(BaseModel):
    message: str
    documents_processed: int
    chunks_created: int

class StatusResponse(BaseModel):
    ollama_connected: bool
    models_available: list[str]
    documents_indexed: int
    collections: list[str]

# ─── ChromaDB Client ─────────────────────────────────────────────────────────

chroma_client = chromadb.PersistentClient(path=str(CHROMA_DIR))

COLLECTION_NAME = "encyclopedie"

def get_collection():
    """Get or create the encyclopédie collection."""
    return chroma_client.get_or_create_collection(
        name=COLLECTION_NAME,
        metadata={"hnsw:space": "cosine"}
    )

# ─── Ollama Helper Functions ─────────────────────────────────────────────────

async def ollama_embed(texts: list[str]) -> list[list[float]]:
    """Get embeddings from Ollama."""
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.post(
                f"{OLLAMA_BASE_URL}/api/embed",
                json={"model": EMBED_MODEL, "input": texts}
            )
            response.raise_for_status()
            data = response.json()
            return data["embeddings"]
    except httpx.TimeoutException as exc:
        raise HTTPException(
            status_code=504,
            detail=f"Ollama ne répond pas assez vite avec le modèle d'embedding '{EMBED_MODEL}'."
        ) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Erreur Ollama pendant l'embedding avec '{EMBED_MODEL}' : {exc}"
        ) from exc

async def ollama_chat(prompt: str, system: str = "", model: str = None) -> str:
    """Chat with the Ollama model."""
    used_model = model or CHAT_MODEL
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    try:
        async with httpx.AsyncClient(timeout=300.0) as client:
            response = await client.post(
                f"{OLLAMA_BASE_URL}/api/chat",
                json={
                    "model": used_model,
                    "messages": messages,
                    "stream": False,
                    "options": {
                        "temperature": 0.3,
                        "top_p": 0.9,
                        "num_ctx": 2048,
                        "num_predict": 512,
                    }
                }
            )
            response.raise_for_status()
            data = response.json()
            return data["message"]["content"]
    except httpx.TimeoutException as exc:
        raise HTTPException(
            status_code=504,
            detail=f"Ollama ne répond pas assez vite avec le modèle de chat '{used_model}'."
        ) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Erreur Ollama pendant la génération avec '{used_model}' : {exc}"
        ) from exc

async def ollama_list_models() -> list[str]:
    """List available Ollama models."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(f"{OLLAMA_BASE_URL}/api/tags")
            response.raise_for_status()
            data = response.json()
            return [m["name"] for m in data.get("models", [])]
    except Exception:
        return []

async def ollama_is_connected() -> bool:
    """Check if Ollama is running."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(f"{OLLAMA_BASE_URL}/")
            return response.status_code == 200
    except Exception:
        return False

# ─── Text Chunking ────────────────────────────────────────────────────────────

def chunk_text(text: str, chunk_size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> list[str]:
    """Split text into overlapping chunks."""
    chunks = []
    # Split by paragraphs first
    paragraphs = text.split("\n\n")
    current_chunk = ""
    
    for para in paragraphs:
        para = para.strip()
        if not para:
            continue
        
        if len(current_chunk) + len(para) + 2 <= chunk_size:
            current_chunk += ("\n\n" + para if current_chunk else para)
        else:
            if current_chunk:
                chunks.append(current_chunk)
            # If paragraph itself is too long, split by sentences
            if len(para) > chunk_size:
                sentences = para.replace(". ", ".\n").split("\n")
                current_chunk = ""
                for sent in sentences:
                    if len(current_chunk) + len(sent) + 1 <= chunk_size:
                        current_chunk += (" " + sent if current_chunk else sent)
                    else:
                        if current_chunk:
                            chunks.append(current_chunk)
                        current_chunk = sent
            else:
                current_chunk = para
    
    if current_chunk:
        chunks.append(current_chunk)
    
    # Add overlap
    if overlap > 0 and len(chunks) > 1:
        overlapped = [chunks[0]]
        for i in range(1, len(chunks)):
            prev_end = chunks[i - 1][-overlap:]
            overlapped.append(prev_end + " [...] " + chunks[i])
        chunks = overlapped
    
    return chunks

# ─── API Endpoints ────────────────────────────────────────────────────────────

@app.get("/api/status", response_model=StatusResponse)
async def get_status():
    """Check the status of the system."""
    connected = await ollama_is_connected()
    models = await ollama_list_models() if connected else []
    collection = get_collection()
    
    return StatusResponse(
        ollama_connected=connected,
        models_available=models,
        documents_indexed=collection.count(),
        collections=[COLLECTION_NAME]
    )

@app.post("/api/ingest", response_model=IngestResponse)
async def ingest_documents():
    """Ingest all text files from the data/raw directory into ChromaDB."""
    collection = get_collection()
    
    # Find all text files
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    text_files = list(RAW_DIR.glob("*.txt")) + list(RAW_DIR.glob("*.md"))
    
    if not text_files:
        raise HTTPException(status_code=404, detail="Aucun fichier texte trouvé dans data/raw/")
    
    total_chunks = 0
    
    for filepath in text_files:
        text = filepath.read_text(encoding="utf-8")
        source = filepath.stem
        
        # Chunk the text
        chunks = chunk_text(text)
        
        if not chunks:
            continue
        
        # Generate IDs based on content hash
        ids = []
        for i, chunk in enumerate(chunks):
            chunk_hash = hashlib.md5(f"{source}_{i}_{chunk[:100]}".encode()).hexdigest()
            ids.append(f"{source}_{chunk_hash}")
        
        # Check which IDs already exist
        existing = collection.get(ids=ids)
        existing_ids = set(existing["ids"]) if existing["ids"] else set()
        
        # Filter out already indexed chunks
        new_chunks = []
        new_ids = []
        new_metadatas = []
        for chunk_id, chunk in zip(ids, chunks):
            if chunk_id not in existing_ids:
                new_chunks.append(chunk)
                new_ids.append(chunk_id)
                new_metadatas.append({
                    "source": source,
                    "file": filepath.name,
                    "indexed_at": time.strftime("%Y-%m-%d %H:%M:%S")
                })
        
        if new_chunks:
            # Get embeddings
            embeddings = await ollama_embed(new_chunks)
            
            # Add to ChromaDB
            collection.add(
                ids=new_ids,
                documents=new_chunks,
                embeddings=embeddings,
                metadatas=new_metadatas
            )
            total_chunks += len(new_chunks)
    
    return IngestResponse(
        message=f"Indexation terminée : {len(text_files)} fichiers traités, {total_chunks} nouveaux passages indexés.",
        documents_processed=len(text_files),
        chunks_created=total_chunks
    )

@app.post("/api/upload")
async def upload_document(file: UploadFile = File(...)):
    """Upload a text file for ingestion."""
    filename = Path(file.filename or "").name
    if not filename.lower().endswith((".txt", ".md")):
        raise HTTPException(status_code=400, detail="Seuls les fichiers .txt et .md sont acceptés")
    
    content = await file.read()
    if len(content) > 5 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Fichier trop volumineux : limite de 5 Mo")

    RAW_DIR.mkdir(parents=True, exist_ok=True)
    save_path = RAW_DIR / filename
    save_path.write_bytes(content)
    
    return {"message": f"Fichier '{filename}' enregistré. Lancez l'indexation pour l'intégrer."}

@app.post("/api/ask", response_model=AnswerResponse)
async def ask_question(request: QuestionRequest):
    """Ask a question to the encyclopédie."""
    start_time = time.time()
    collection = get_collection()
    question = request.question.strip()
    
    if collection.count() == 0:
        raise HTTPException(
            status_code=400, 
            detail="Aucun document indexé. Veuillez d'abord lancer l'indexation via /api/ingest"
        )
    
    # Embed the question
    question_embedding = await ollama_embed([question])
    
    # Search in ChromaDB
    results = collection.query(
        query_embeddings=question_embedding,
        n_results=min(request.top_k, collection.count()),
        include=["documents", "metadatas", "distances"]
    )
    
    # Build context from retrieved documents
    sources = []
    context_parts = []
    
    if results["documents"] and results["documents"][0]:
        for doc, meta, distance in zip(
            results["documents"][0],
            results["metadatas"][0],
            results["distances"][0]
        ):
            score = 1 - distance  # Convert distance to similarity
            sources.append(SourceDocument(
                content=doc[:500],
                source=meta.get("source", "inconnu"),
                score=round(score, 3)
            ))
            context_parts.append(doc)
    
    context = "\n\n---\n\n".join(context_parts)
    
    # Build the RAG prompt
    system_prompt = """Tu es un érudit bibliothécaire spécialisé dans les encyclopédies françaises d'avant 1939. 
Tu réponds aux questions en t'appuyant UNIQUEMENT sur les extraits encyclopédiques fournis ci-dessous.

Règles strictes :
1. Réponds UNIQUEMENT avec les informations contenues dans le contexte fourni.
2. Si l'information n'est pas dans le contexte, dis-le clairement : "Cette information ne figure pas dans les articles encyclopédiques dont je dispose."
3. Adopte un ton savant mais accessible, dans le style des encyclopédies françaises de l'époque.
4. Cite les sources quand c'est pertinent (nom de l'article).
5. N'invente JAMAIS d'informations. Ne complète pas avec des connaissances modernes.
6. Réponds en français.
7. Si la question porte sur un sujet postérieur à 1939, rappelle poliment que cette encyclopédie ne couvre que la période allant jusqu'en 1939."""

    user_prompt = f"""EXTRAITS ENCYCLOPÉDIQUES :

{context}

---

QUESTION : {question}

Réponds en t'appuyant uniquement sur les extraits ci-dessus."""

    used_model = request.model or CHAT_MODEL
    
    # Get the answer from Ollama
    answer = await ollama_chat(user_prompt, system=system_prompt, model=used_model)
    
    elapsed = time.time() - start_time
    
    return AnswerResponse(
        answer=answer,
        sources=sources,
        model=used_model,
        elapsed_seconds=round(elapsed, 2)
    )

@app.delete("/api/reset")
async def reset_collection():
    """Reset the vector database."""
    try:
        chroma_client.delete_collection(COLLECTION_NAME)
    except Exception:
        pass
    get_collection()
    return {"message": "Base vectorielle réinitialisée."}

@app.get("/api/documents")
async def list_documents():
    """List all raw documents available."""
    files = list(RAW_DIR.glob("*.txt")) + list(RAW_DIR.glob("*.md"))
    return {
        "documents": [
            {
                "name": f.name,
                "size_bytes": f.stat().st_size,
                "size_kb": round(f.stat().st_size / 1024, 1)
            }
            for f in sorted(files)
        ]
    }

# ─── Serve Frontend ──────────────────────────────────────────────────────────

# Mount frontend static files
if FRONTEND_DIR.exists():
    app.mount("/assets", StaticFiles(directory=str(FRONTEND_DIR / "assets")), name="assets")
    
    @app.get("/")
    async def serve_index():
        return FileResponse(str(FRONTEND_DIR / "index.html"))

# ─── Main ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8900, reload=True)
