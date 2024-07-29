# Use the latest stable Node.js runtime as the base image
FROM node:18

# Install Python 3.10, ffmpeg, and yt-dlp
RUN apt-get update && \
    apt-get install -y python3.10 python3.10-venv python3.10-dev && \
    apt-get install -y ffmpeg && \
    apt-get install -y curl && \
    curl -sS https://bootstrap.pypa.io/get-pip.py | python3.10 && \
    python3.10 -m pip install yt-dlp

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Expose the port the app runs on
EXPOSE 4002

# Command to run the app
CMD ["node", "multifile.js"]
