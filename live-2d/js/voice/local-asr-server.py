import asyncio
import json
import logging
from array import array
from pathlib import Path

import sherpa_onnx
import websockets


ROOT = Path(__file__).resolve().parents[2] / 'plugins-dlc' / 'local-asr'
MODEL = ROOT / 'paraformer'
PORT = 1001


def create_recognizer():
    return sherpa_onnx.OnlineRecognizer.from_paraformer(
        tokens=str(MODEL / 'tokens.txt'),
        encoder=str(MODEL / 'encoder.int8.onnx'),
        decoder=str(MODEL / 'decoder.int8.onnx'),
        num_threads=2,
        provider='cpu',
        enable_endpoint_detection=True,
        rule1_min_trailing_silence=2.4,
        rule2_min_trailing_silence=1.2,
        rule3_min_utterance_length=20.0,
    )


recognizer = create_recognizer()


async def handle_client(ws):
    stream = recognizer.create_stream()
    last_text = ''
    try:
        async for message in ws:
            if not isinstance(message, bytes) or len(message) % 2:
                continue
            samples = array('h')
            samples.frombytes(message)
            stream.accept_waveform(16000, [sample / 32768.0 for sample in samples])

            while recognizer.is_ready(stream):
                recognizer.decode_stream(stream)

            text = recognizer.get_result(stream).strip()
            if text and text != last_text:
                last_text = text
                await ws.send(json.dumps({'type': 'interim', 'text': text}))

            if recognizer.is_endpoint(stream):
                if text:
                    await ws.send(json.dumps({'type': 'final', 'text': text}))
                    logging.info('识别: %s', text)
                recognizer.reset(stream)
                last_text = ''
    except websockets.ConnectionClosed:
        pass
    except Exception:
        logging.exception('识别连接出错')


async def main():
    logging.basicConfig(level=logging.INFO, format='[ASR] %(message)s')
    async with websockets.serve(handle_client, '127.0.0.1', PORT, max_size=256 * 1024):
        logging.info('本地流式识别已就绪: ws://127.0.0.1:%s', PORT)
        await asyncio.Future()


if __name__ == '__main__':
    asyncio.run(main())
