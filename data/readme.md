# src/data

This directory is no longer used at runtime.  
All persistent data is now stored in `/var/data/` (as configured by `DATA_DIR`).

If you're running the app locally, set:
```bash
export DATA_DIR="./data"