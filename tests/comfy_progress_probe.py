import asyncio
import sys
import websockets


async def main():
    async with websockets.connect('ws://127.0.0.1:8190/ws?clientId=' + sys.argv[1]) as socket:
        for _ in range(4):
            try:
                print(await asyncio.wait_for(socket.recv(), 10))
            except asyncio.TimeoutError:
                print('No new progress event in 10 seconds')
                return


asyncio.run(main())
