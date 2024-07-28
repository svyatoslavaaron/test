# Use an official Node.js runtime as the base image
FROM node:14

# Install Python, ffmpeg, and yt-dlp
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg

# Install yt-dlp
RUN pip3 install yt-dlp

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
