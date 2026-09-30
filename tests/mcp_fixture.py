"""Read-only MCP fixture used by the settings connection test."""
from mcp.server.fastmcp import FastMCP

app = FastMCP('Settings fixture')


@app.tool()
def echo(message: str) -> str:
    return message


if __name__ == '__main__':
    app.run()
