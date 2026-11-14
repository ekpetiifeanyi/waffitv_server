// ping server every 10 minutes
function keepServerAlive(url) {
    const minutes = 10;
    const interval = minutes * 60 * 1000;
    console.log(`[Keep-Alive] Monitoring started for: ${url}; every  ${minutes} minutes`);

    async function pingServer() {
        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const data = await response.json();
            console.log(`[Keep-Alive] Ping successful at ${ data.timestamp || new Date().toISOString()}`);
        } catch (error) {
            console.error('[Keep-Alive] Ping failed:', error.message);
        }
    }
    pingServer();
    setInterval(pingServer, interval);
}

module.exports = { keepServerAlive };
