export const createStreamProxy = (responseBody: ReadableStream<Uint8Array>, responseHeaders: Headers) => {
    let chunkCount = 0;
    let lastChunkData = '';
    let totalBytes = 0;
    const reader = responseBody.getReader();
    const decoder = new TextDecoder();
    
    const stream = new ReadableStream({
        async pull(controller) {
            try {
                const { done, value } = await reader.read();
                if (done) {
                    console.log(`✅ Stream complete: ${chunkCount} chunks, ${totalBytes} bytes`);
                    console.log(`✅ Last chunk: ${lastChunkData.slice(-200)}`);
                    controller.close();
                    return;
                }
                chunkCount++;
                totalBytes += value.length;
                lastChunkData = decoder.decode(value, { stream: true });
                if (chunkCount === 1) {
                    console.log(`📡 Stream started, first chunk: ${lastChunkData.slice(0, 200)}`);
                }
                if (lastChunkData.includes('"error"')) {
                    console.error(`❌ Error in stream chunk ${chunkCount}: ${lastChunkData.slice(0, 500)}`);
                }
                if (lastChunkData.includes('finish_reason')) {
                    const match = lastChunkData.match(/"finish_reason"\s*:\s*"([^"]+)"/);
                    if (match) {
                        console.log(`📡 finish_reason: "${match[1]}" at chunk ${chunkCount}`);
                    }
                }
                controller.enqueue(value);
            } catch (err: any) {
                if (err?.code === 'ERR_INVALID_THIS') return;
                console.error(`❌ Stream read error at chunk ${chunkCount}:`, err);
                try { controller.error(err); } catch {}
            }
        },
        cancel() {
            console.log(`⚠️ Stream cancelled by client after ${chunkCount} chunks, ${totalBytes} bytes`);
            try { reader.cancel(); } catch {}
        }
    });

    return new Response(stream, {
        status: 200,
        headers: responseHeaders,
    });
};
