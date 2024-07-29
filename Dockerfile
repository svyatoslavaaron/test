# Use the latest Ubuntu as the base image
FROM ubuntu:22.04

# Install Node.js, Python 3.10, ffmpeg, curl, and yt-dlp
RUN apt-get update && \
    apt-get install -y nodejs npm python3.10 python3.10-venv python3.10-dev ffmpeg curl && \
    curl -sS https://bootstrap.pypa.io/get-pip.py | python3.10 && \
    python3.10 -m pip install --upgrade pip && \
    python3.10 -m pip install --upgrade yt-dlp

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install Node.js dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Expose the port the app runs on
EXPOSE 4002

# Command to run the app
CMD ["node", "multifile.js"]
