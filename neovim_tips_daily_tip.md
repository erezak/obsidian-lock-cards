# Get current buffer path in register

### Category: Registers

### Tags: buffer, path, filename, register, clipboard

Use `"%p` to paste current filename, `:let @+=@%` to copy buffer name to system clipboard.

#### Example

```vim
"%p            " paste current filename
":let @+=@%     " copy current buffer name to system clipboard
":let @"=@%     " copy current buffer name to default register
```

---

Have your favorite tip? Found an error?  
Please report it [here](https://github.com/saxon1964/neovim-tips/issues)!

For daily tip setup refer to [README](https://github.com/saxon1964/neovim-tips) file.

