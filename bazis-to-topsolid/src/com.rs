#![cfg(windows)]

use std::ffi::c_void;
use std::ptr::{null, null_mut};

use windows_sys::core::{BSTR, GUID, HRESULT, PCWSTR};
use windows_sys::Win32::Foundation::{
    SysAllocStringLen, SysFreeString, SysStringLen, VARIANT_BOOL, VARIANT_FALSE, VARIANT_TRUE,
};
use windows_sys::Win32::System::Com::{
    CLSIDFromProgID, CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_LOCAL_SERVER,
    CLSCTX_SERVER, COINIT_APARTMENTTHREADED, DISPATCH_METHOD, DISPATCH_PROPERTYGET,
    DISPATCH_PROPERTYPUT, DISPPARAMS, EXCEPINFO, SAFEARRAY, SAFEARRAYBOUND,
};
use windows_sys::Win32::System::Ole::{
    SafeArrayCreate, SafeArrayPutElement, DISPID_PROPERTYPUT,
};
use windows_sys::Win32::System::Variant::{
    VariantClear, VariantInit, VARIANT, VT_ARRAY, VT_BOOL, VT_BSTR, VT_DISPATCH, VT_EMPTY, VT_I4,
    VT_R8, VT_VARIANT,
};

// Standard IID_IDispatch = {00020400-0000-0000-C000-000000000046}
const IID_IDISPATCH: GUID = GUID {
    data1: 0x00020400,
    data2: 0x0000,
    data3: 0x0000,
    data4: [0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46],
};
const IID_NULL: GUID = GUID {
    data1: 0,
    data2: 0,
    data3: 0,
    data4: [0; 8],
};

#[repr(C)]
struct IDispatchVtbl {
    query_interface: unsafe extern "system" fn(*mut c_void, *const GUID, *mut *mut c_void) -> HRESULT,
    add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
    release: unsafe extern "system" fn(*mut c_void) -> u32,
    get_type_info_count: unsafe extern "system" fn(*mut c_void, *mut u32) -> HRESULT,
    get_type_info: unsafe extern "system" fn(*mut c_void, u32, u32, *mut *mut c_void) -> HRESULT,
    get_ids_of_names: unsafe extern "system" fn(
        *mut c_void,
        *const GUID,
        *const PCWSTR,
        u32,
        u32,
        *mut i32,
    ) -> HRESULT,
    invoke: unsafe extern "system" fn(
        *mut c_void,
        i32,
        *const GUID,
        u32,
        u16,
        *const DISPPARAMS,
        *mut VARIANT,
        *mut EXCEPINFO,
        *mut u32,
    ) -> HRESULT,
}

#[repr(C)]
struct IDispatchRaw {
    vtbl: *const IDispatchVtbl,
}

pub fn to_wide_null(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

pub fn make_bstr(s: &str) -> BSTR {
    let w: Vec<u16> = s.encode_utf16().collect();
    unsafe { SysAllocStringLen(w.as_ptr(), w.len() as u32) }
}

pub fn bstr_to_string(b: BSTR) -> String {
    if b.is_null() {
        return String::new();
    }
    unsafe {
        let len = SysStringLen(b) as usize;
        let slice = std::slice::from_raw_parts(b, len);
        String::from_utf16_lossy(slice)
    }
}

pub struct ComGuard;

impl ComGuard {
    pub fn init_sta() -> Result<Self, String> {
        let hr = unsafe { CoInitializeEx(null(), COINIT_APARTMENTTHREADED as u32) };
        if hr < 0 {
            return Err(format!("CoInitializeEx failed: 0x{:08X}", hr as u32));
        }
        Ok(Self)
    }
}

impl Drop for ComGuard {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

pub struct ComObj {
    ptr: *mut IDispatchRaw,
}

impl ComObj {
    pub fn create(prog_id: &str) -> Result<Self, String> {
        let wide = to_wide_null(prog_id);
        let mut clsid = IID_NULL;
        let hr = unsafe { CLSIDFromProgID(wide.as_ptr(), &mut clsid) };
        if hr < 0 {
            return Err(format!(
                "CLSIDFromProgID('{}') failed: 0x{:08X}",
                prog_id, hr as u32
            ));
        }
        let mut raw: *mut c_void = null_mut();
        let hr = unsafe {
            CoCreateInstance(
                &clsid,
                null_mut(),
                (CLSCTX_LOCAL_SERVER | CLSCTX_SERVER) as u32,
                &IID_IDISPATCH,
                &mut raw,
            )
        };
        if hr < 0 || raw.is_null() {
            return Err(format!(
                "CoCreateInstance('{}') failed: 0x{:08X}",
                prog_id, hr as u32
            ));
        }
        Ok(Self {
            ptr: raw as *mut IDispatchRaw,
        })
    }

    pub fn from_raw(ptr: *mut c_void) -> Option<Self> {
        if ptr.is_null() {
            None
        } else {
            Some(Self {
                ptr: ptr as *mut IDispatchRaw,
            })
        }
    }

    pub fn raw(&self) -> *mut c_void {
        self.ptr as *mut c_void
    }

    pub fn add_ref_raw(&self) -> *mut c_void {
        unsafe {
            ((*(*self.ptr).vtbl).add_ref)(self.ptr as *mut c_void);
        }
        self.ptr as *mut c_void
    }

    fn get_dispid(&self, name: &str) -> Result<i32, String> {
        let w = to_wide_null(name);
        let mut name_ptr: PCWSTR = w.as_ptr();
        let mut dispid: i32 = 0;
        let hr = unsafe {
            ((*(*self.ptr).vtbl).get_ids_of_names)(
                self.ptr as *mut c_void,
                &IID_NULL,
                &mut name_ptr,
                1,
                0,
                &mut dispid,
            )
        };
        if hr < 0 {
            return Err(format!(
                "GetIDsOfNames('{}') failed: 0x{:08X}",
                name, hr as u32
            ));
        }
        Ok(dispid)
    }

    pub fn invoke_raw(
        &self,
        name: &str,
        flags: u16,
        args: &[ComArg],
    ) -> Result<OwnedVariant, String> {
        let dispid = self.get_dispid(name)?;
        // IDispatch expects arguments in REVERSE order
        let mut vargs: Vec<VARIANT> = Vec::with_capacity(args.len());
        for a in args.iter().rev() {
            vargs.push(a.to_variant());
        }
        let mut named_put: i32 = DISPID_PROPERTYPUT;
        let is_put = (flags & (DISPATCH_PROPERTYPUT as u16)) != 0;
        let dp = DISPPARAMS {
            rgvarg: if vargs.is_empty() {
                null_mut()
            } else {
                vargs.as_mut_ptr()
            },
            rgdispidNamedArgs: if is_put { &mut named_put } else { null_mut() },
            cArgs: vargs.len() as u32,
            cNamedArgs: if is_put { 1 } else { 0 },
        };
        let mut result: VARIANT = unsafe { std::mem::zeroed() };
        unsafe { VariantInit(&mut result) };
        let mut excep: EXCEPINFO = unsafe { std::mem::zeroed() };
        let mut arg_err: u32 = 0;

        let hr = unsafe {
            ((*(*self.ptr).vtbl).invoke)(
                self.ptr as *mut c_void,
                dispid,
                &IID_NULL,
                0,
                flags,
                &dp,
                if is_put { null_mut() } else { &mut result },
                &mut excep,
                &mut arg_err,
            )
        };

        for mut v in vargs {
            unsafe { VariantClear(&mut v) };
        }

        if hr < 0 {
            let desc = bstr_to_string(excep.bstrDescription);
            unsafe {
                if !excep.bstrSource.is_null() {
                    SysFreeString(excep.bstrSource);
                }
                if !excep.bstrDescription.is_null() {
                    SysFreeString(excep.bstrDescription);
                }
                if !excep.bstrHelpFile.is_null() {
                    SysFreeString(excep.bstrHelpFile);
                }
                VariantClear(&mut result);
            }
            return Err(format!(
                "Invoke('{}') failed: 0x{:08X} {}",
                name, hr as u32, desc
            ));
        }

        Ok(OwnedVariant(result))
    }

    pub fn get(&self, name: &str) -> Result<OwnedVariant, String> {
        self.invoke_raw(name, (DISPATCH_PROPERTYGET | DISPATCH_METHOD) as u16, &[])
    }

    pub fn get_obj(&self, name: &str) -> Result<ComObj, String> {
        self.get(name)?
            .into_obj()
            .ok_or_else(|| format!("Property '{}' returned null object", name))
    }

    pub fn put(&self, name: &str, val: ComArg) -> Result<(), String> {
        self.invoke_raw(name, DISPATCH_PROPERTYPUT as u16, &[val])?;
        Ok(())
    }

    pub fn call(&self, name: &str, args: &[ComArg]) -> Result<OwnedVariant, String> {
        self.invoke_raw(name, DISPATCH_METHOD as u16, args)
    }

    pub fn call_obj(&self, name: &str, args: &[ComArg]) -> Result<ComObj, String> {
        self.call(name, args)?
            .into_obj()
            .ok_or_else(|| format!("Method '{}' returned null object", name))
    }
}

impl Drop for ComObj {
    fn drop(&mut self) {
        if !self.ptr.is_null() {
            unsafe {
                ((*(*self.ptr).vtbl).release)(self.ptr as *mut c_void);
            }
        }
    }
}

pub enum ComArg<'a> {
    F64(f64),
    I32(i32),
    Bool(bool),
    Str(&'a str),
    Obj(&'a ComObj),
    NullDispatch,
    ObjArray(&'a [ComObj]),
}

impl<'a> ComArg<'a> {
    fn to_variant(&self) -> VARIANT {
        unsafe {
            let mut v: VARIANT = std::mem::zeroed();
            VariantInit(&mut v);
            match self {
                ComArg::F64(n) => {
                    v.Anonymous.Anonymous.vt = VT_R8;
                    v.Anonymous.Anonymous.Anonymous.dblVal = *n;
                }
                ComArg::I32(n) => {
                    v.Anonymous.Anonymous.vt = VT_I4;
                    v.Anonymous.Anonymous.Anonymous.lVal = *n;
                }
                ComArg::Bool(b) => {
                    v.Anonymous.Anonymous.vt = VT_BOOL;
                    v.Anonymous.Anonymous.Anonymous.boolVal = if *b {
                        VARIANT_TRUE
                    } else {
                        VARIANT_FALSE
                    } as VARIANT_BOOL;
                }
                ComArg::Str(s) => {
                    v.Anonymous.Anonymous.vt = VT_BSTR;
                    v.Anonymous.Anonymous.Anonymous.bstrVal = make_bstr(s);
                }
                ComArg::Obj(o) => {
                    v.Anonymous.Anonymous.vt = VT_DISPATCH;
                    v.Anonymous.Anonymous.Anonymous.pdispVal = o.add_ref_raw();
                }
                ComArg::NullDispatch => {
                    v.Anonymous.Anonymous.vt = VT_DISPATCH;
                    v.Anonymous.Anonymous.Anonymous.pdispVal = null_mut();
                }
                ComArg::ObjArray(objs) => {
                    let bound = SAFEARRAYBOUND {
                        cElements: objs.len() as u32,
                        lLbound: 0,
                    };
                    let psa: *mut SAFEARRAY = SafeArrayCreate(VT_VARIANT, 1, &bound);
                    if !psa.is_null() {
                        for (idx, obj) in objs.iter().enumerate() {
                            let mut elem: VARIANT = std::mem::zeroed();
                            VariantInit(&mut elem);
                            elem.Anonymous.Anonymous.vt = VT_DISPATCH;
                            elem.Anonymous.Anonymous.Anonymous.pdispVal = obj.add_ref_raw();
                            let i = idx as i32;
                            SafeArrayPutElement(psa, &i, &elem as *const VARIANT as *const c_void);
                            VariantClear(&mut elem);
                        }
                        v.Anonymous.Anonymous.vt = VT_ARRAY | VT_VARIANT;
                        v.Anonymous.Anonymous.Anonymous.parray = psa;
                    } else {
                        v.Anonymous.Anonymous.vt = VT_EMPTY;
                    }
                }
            }
            v
        }
    }
}

pub struct OwnedVariant(VARIANT);

impl OwnedVariant {
    pub fn into_obj(mut self) -> Option<ComObj> {
        unsafe {
            if self.0.Anonymous.Anonymous.vt == VT_DISPATCH {
                let p = self.0.Anonymous.Anonymous.Anonymous.pdispVal;
                self.0.Anonymous.Anonymous.vt = VT_EMPTY;
                ComObj::from_raw(p)
            } else {
                None
            }
        }
    }

    pub fn as_i32(&self) -> i32 {
        unsafe {
            match self.0.Anonymous.Anonymous.vt {
                VT_I4 => self.0.Anonymous.Anonymous.Anonymous.lVal,
                VT_R8 => self.0.Anonymous.Anonymous.Anonymous.dblVal as i32,
                _ => 0,
            }
        }
    }

    pub fn as_f64(&self) -> f64 {
        unsafe {
            match self.0.Anonymous.Anonymous.vt {
                VT_R8 => self.0.Anonymous.Anonymous.Anonymous.dblVal,
                VT_I4 => self.0.Anonymous.Anonymous.Anonymous.lVal as f64,
                _ => 0.0,
            }
        }
    }

    pub fn as_string(&self) -> String {
        unsafe {
            if self.0.Anonymous.Anonymous.vt == VT_BSTR {
                bstr_to_string(self.0.Anonymous.Anonymous.Anonymous.bstrVal)
            } else {
                String::new()
            }
        }
    }
}

impl Drop for OwnedVariant {
    fn drop(&mut self) {
        unsafe { VariantClear(&mut self.0) };
    }
}
