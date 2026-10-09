namespace VpnRoute.NativeHost.Tests.Support;

/// <summary>Delivers an initial buffer then blocks until cancelled (simulates an open connectNative stdin).</summary>
internal sealed class BlockingInputStream(byte[] initial, CancellationToken cancellationToken) : Stream
{
    private int _offset;

    public override bool CanRead => true;
    public override bool CanSeek => false;
    public override bool CanWrite => false;
    public override long Length => throw new NotSupportedException();
    public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }

    public override void Flush() { }

    public override int Read(byte[] buffer, int offset, int count)
    {
        if (_offset < initial.Length)
        {
            var n = Math.Min(count, initial.Length - _offset);
            Array.Copy(initial, _offset, buffer, offset, n);
            _offset += n;
            return n;
        }

        while (!cancellationToken.IsCancellationRequested)
        {
            cancellationToken.WaitHandle.WaitOne(50);
        }
        return 0;
    }

    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
}
