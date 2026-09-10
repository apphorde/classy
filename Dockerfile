FROM ghcr.io/cloud-cli/image-node:latest

# Install python-pip and ffmpeg for audio/video extraction
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3-pip \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV PIP_BREAK_SYSTEM_PACKAGES=1

# Copy project manifest files
COPY package.json requirements.txt* ./

# Install packages
RUN npm install
RUN if [ -f requirements.txt ]; then pip3 install --no-cache-dir -r requirements.txt; fi

# Copy application source code
COPY . .

# Run the primary indexing loop
CMD ["node", "indexer.mjs"]
