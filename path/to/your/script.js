// Updated function to add video to playlist with detailed error reporting
function addVideoToPlaylist_(videoId, playlistId) {
    try {
        YouTube.PlaylistItems.insert({...}); // Existing logic here
    } catch (error) {
        errors.push({ videoId, message: error.message }); // Collecting error details
    }
}

function createMixedPlaylist(videos) {
    let errors = []; // Array to hold errors
    let errorCount = 0;
    videos.forEach(videoId => {
        try {
            addVideoToPlaylist_(videoId, playlistId);
        } catch (error) {
            errorCount++;
            errors.push({ videoId, message: error.message });
        }
    });
    return { errorCount, errors }; // Return errors details along with count
}